-- ============================================================
-- 052_revoke_public_execute
--
-- Cierra P0-SEC-05: ninguna función SECURITY DEFINER queda con
-- EXECUTE para PUBLIC.
--
-- EL PROBLEMA
--
-- Postgres concede EXECUTE a PUBLIC en toda función nueva, sin que
-- nadie lo escriba. Una función SECURITY DEFINER, por definición,
-- corre con los privilegios de su dueño y **se salta RLS** — es su
-- razón de ser. Las dos cosas juntas significan que cada función de
-- este esquema que nadie revocó a mano es una escritura sin RLS
-- accesible con la clave `anon`, la misma que viaja en el bundle del
-- navegador y es pública por diseño.
--
-- No es teórico. Medido contra el stack local, antes de esta
-- migración, con solo la clave anon y sin sesión alguna:
--
--   POST /rest/v1/rpc/record_webhook_failure
--     {"endpoint_id":"<uuid>","max_failures":1}
--   → HTTP 204, y el endpoint pasa de is_active=true a false.
--
-- Es decir: cualquiera desactiva el webhook de cualquier inquilino
-- con una petición. `claim_ai_reply_slot` es del mismo tipo — agota
-- el presupuesto de auto-respuesta de una conversación ajena — y su
-- identificador es justo el que ahora viaja en la URL del inbox
-- (/inbox/<conversationId>, P0-BUG-04), así que basta un enlace
-- compartido o una captura.
--
-- CORRECCIÓN AL PLAN
--
-- La tarea decía «revocar EXECUTE a PUBLIC» y nombraba cinco
-- funciones. Ambas cosas se quedan cortas, comprobado contra
-- pg_proc:
--
--   1. Son ONCE las funciones SECURITY DEFINER con EXECUTE para
--      PUBLIC, no cinco.
--   2. Revocar solo a PUBLIC no basta. `pg_default_acl` muestra que
--      en el esquema public hay ALTER DEFAULT PRIVILEGES que conceden
--      EXECUTE directamente a `anon` y `authenticated`. Una concesión
--      directa sobrevive a REVOKE ... FROM PUBLIC. Por eso aquí se
--      revoca a los tres y se vuelve a conceder solo lo necesario.
--
-- CRITERIO
--
-- Cada función recupera exactamente el rol que la llama de verdad,
-- verificado contra el código, no supuesto:
--
--   service_role  → la llama el servidor (cliente service-role).
--   authenticated → la llama el navegador con sesión.
--   (ninguno)     → solo la invoca un trigger o otra función
--                   SECURITY DEFINER, y ahí el usuario efectivo es el
--                   dueño (postgres), que no necesita concesión.
--
-- Nota sobre triggers: Postgres comprueba EXECUTE al CREAR el
-- trigger, no al dispararlo, y PostgREST no expone funciones que
-- devuelven `trigger`. Revocarlas no las rompe; se verifica
-- ejercitándolas, no razonando sobre ellas.
--
-- Idempotente — seguro de reejecutar.
-- ============================================================

-- ============================================================
-- 1. SERVIDOR (service_role)
-- ============================================================

-- src/lib/ai/auto-reply.ts:165 — cliente service-role.
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer)
  TO service_role;

-- src/lib/webhooks/deliver.ts:151 — cliente service-role.
REVOKE ALL ON FUNCTION public.record_webhook_failure(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, integer)
  TO service_role;

-- ============================================================
-- 2. NAVEGADOR CON SESIÓN (authenticated)
-- ============================================================

-- src/components/presence/presence-heartbeat.tsx:59 — el latido de
-- presencia sale del navegador. La función ya se defiende sola
-- (RAISE 42501 si auth.uid() es NULL), y eso no cambia: es defensa en
-- profundidad, no un sustituto de la concesión.
REVOKE ALL ON FUNCTION public.touch_presence(text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touch_presence(text)
  TO authenticated;

-- src/hooks/use-unread-notifications.ts:25 — el navegador dispara el
-- barrido de tareas vencidas. Acota por la cuenta del propio llamante.
REVOKE ALL ON FUNCTION public.process_due_tasks()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_due_tasks()
  TO authenticated;

-- ============================================================
-- 3. PREDICADO DE RLS
-- ============================================================

-- `is_account_member` es distinto y merece explicación, porque aquí
-- `anon` SÍ conserva EXECUTE.
--
-- 120 políticas RLS de este esquema lo invocan con rol `{public}`, es
-- decir aplicables a cualquier rol, `anon` incluido. Cuando una
-- política llama a una función, Postgres comprueba EXECUTE contra el
-- rol que consulta. Sin concesión, una consulta anónima contra
-- cualquiera de esas 120 tablas dejaría de devolver cero filas y
-- pasaría a fallar con «permission denied for function».
--
-- Y no se gana nada a cambio: la función es un predicado puro que
-- pregunta si auth.uid() pertenece a la cuenta. Sin sesión, auth.uid()
-- es NULL, ninguna fila de profiles casa y devuelve false siempre. No
-- filtra si la cuenta existe, ni quién la compone — no sirve de
-- oráculo. Se revoca PUBLIC (que es lo que pide la tarea) y se
-- conceden los roles reales de forma explícita.
REVOKE ALL ON FUNCTION public.is_account_member(uuid, account_role_enum)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_account_member(uuid, account_role_enum)
  TO anon, authenticated, service_role;

-- ============================================================
-- 4. SOLO PARA TRIGGERS O USO INTERNO
--
-- Nadie las llama por RPC. `_bcast_bump` y
-- `recompute_broadcast_counts` se invocan desde dentro de
-- `broadcast_recipient_aggregate_trigger`, que es SECURITY DEFINER:
-- allí el usuario efectivo es postgres y la concesión sobra.
-- ============================================================

REVOKE ALL ON FUNCTION public._bcast_bump(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.broadcast_recipient_aggregate_trigger()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_conversation_assigned()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_deal_assigned()
  FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 5. LAS QUE YA ESTABAN BIEN — se reafirma la revocación a anon
--
-- Estas ya tenían REVOKE ... FROM PUBLIC en su migración original, así
-- que la tarea las daba por cerradas. En producción lo están. Se
-- repiten aquí por dos razones: el seed de desarrollo las volvía a
-- abrir con un GRANT ALL ON ALL FUNCTIONS (corregido en el mismo
-- commit), y una concesión directa a `anon` desde ALTER DEFAULT
-- PRIVILEGES sobreviviría igualmente al REVOKE de PUBLIC. Reafirmarlo
-- es idempotente y deja el invariante comprobable de un vistazo.
-- ============================================================

REVOKE ALL ON FUNCTION public.merge_contact_group(uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_duplicate_contacts()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_automation_execution_count(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_automation_execution_count(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.increment_flow_execution_count(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_flow_execution_count(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.increment_tracked_link_clicks(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_tracked_link_clicks(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.update_conversation_last_message(uuid, text, timestamptz, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_conversation_last_message(uuid, text, timestamptz, boolean)
  TO service_role;

-- Invitaciones: `peek_invitation` es la única que `anon` debe poder
-- llamar — ocurre antes de que exista sesión (/join/[token]).
REVOKE ALL ON FUNCTION public.peek_invitation(text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.peek_invitation(text)
  TO anon, authenticated;

REVOKE ALL ON FUNCTION public.redeem_invitation(text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(text)
  TO authenticated;

-- Gestión de miembros: siempre con sesión.
REVOKE ALL ON FUNCTION public.remove_account_member(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_account_member(uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.set_member_role(uuid, account_role_enum)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_role(uuid, account_role_enum)
  TO authenticated;

REVOKE ALL ON FUNCTION public.transfer_account_ownership(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(uuid)
  TO authenticated;
