-- ============================================================
-- CRM — which schema releases are already applied?
--
-- There is no migration runner in this setup: the bundles under
-- docs/deploy/ are pasted into the Supabase SQL editor by hand, and
-- nothing records that they ran. So before a deploy the only honest
-- answer to "did I already apply that one?" comes from looking at the
-- schema itself.
--
-- Paste this into Supabase Cloud -> SQL Editor and run it. Every row
-- should read APPLIED before you redeploy the matching code.
--
-- DOS COLUMNAS, DOS PREGUNTAS DISTINTAS (P0-SEC-07)
--
--   status    -- que hay REALMENTE en el esquema, mirando el catalogo
--   registro  -- que dice el registro que alguien aplico
--
-- Se ensenan juntas porque lo interesante es cuando NO coinciden:
--
--   APPLIED + sin registrar  El objeto esta pero nadie anoto el bundle.
--                            Normal en proyectos anteriores al registro
--                            (la 053 rellena lo que puede comprobar).
--                            En un proyecto reciente significa que el
--                            editor corto el script antes del final.
--
--   MISSING + registrado     El peor caso, y el que este cruce existe
--                            para cazar: alguien lo dio por aplicado y
--                            no lo esta. Un script cortado a la mitad
--                            deja justo esto.
--
-- Casi read-only: crea `schema_release` si falta, porque un proyecto
-- anterior a la 053 no la tiene y sin ella este script no correria.
-- Crear una tabla de metadatos vacia es inocuo; no toca ningun dato.
-- ============================================================

-- El arranque del propio registro. Identico al bloque que lleva cada
-- bundle al final.
CREATE TABLE IF NOT EXISTS public.schema_release (
  version TEXT PRIMARY KEY,
  bundle TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by TEXT NOT NULL DEFAULT current_user
);
ALTER TABLE public.schema_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.schema_release FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.schema_release TO service_role;

WITH checks AS (
  SELECT
    -- The two de-dup indexes are what stop one customer from
    -- fragmenting into a wall of duplicate contacts and threads. They
    -- predate this file, so a production DB set up before it can be
    -- missing them with nothing to say so — which is exactly how it
    -- went unnoticed. Check them first.
    '022 contact phone dedup' AS release,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'contacts' AND column_name = 'phone_normalized')
      AND to_regclass('public.idx_contacts_account_phone_normalized') IS NOT NULL
      AS ok,
    'docs/deploy/inbox-dedup.sql' AS bundle
  UNION ALL
  SELECT
    '036 conversation dedup',
    to_regclass('public.idx_conversations_account_contact') IS NOT NULL,
    'docs/deploy/inbox-dedup.sql'
  UNION ALL
  SELECT
    -- 046 repairs merge_duplicate_contacts(), which 036 silently broke:
    -- with both applied, merging any contact group that holds more than
    -- one conversation dies on idx_conversations_account_contact. The
    -- extracted core is the only trace it leaves.
    '046 contact merge fix',
    to_regprocedure('public.merge_contact_group(uuid[])') IS NOT NULL,
    'docs/deploy/fix-contact-merge.sql'
  UNION ALL
  SELECT
    '037 attribution',
    to_regclass('public.attribution_events') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'contacts' AND column_name = 'source'),
    'docs/deploy/ads-attribution.sql'
  UNION ALL
  SELECT
    '038 ad platforms',
    to_regclass('public.ad_accounts') IS NOT NULL
      AND to_regclass('public.ad_campaigns') IS NOT NULL
      AND to_regclass('public.ad_metrics_daily') IS NOT NULL,
    'docs/deploy/ads-attribution.sql'
  UNION ALL
  SELECT
    '039 deal closed_at',
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'deals' AND column_name = 'closed_at'),
    'docs/deploy/ads-attribution.sql'
  UNION ALL
  SELECT
    '040 tracked links',
    to_regclass('public.tracked_links') IS NOT NULL,
    'docs/deploy/ads-attribution.sql'
  UNION ALL
  SELECT
    -- 041 adds no table or column: it only widens the notifications
    -- type CHECK to accept 'deal_assigned', so the constraint body is
    -- the only trace it leaves.
    '041 deal assignment',
    EXISTS (SELECT 1 FROM pg_constraint
            WHERE conname = 'notifications_type_check'
              AND pg_get_constraintdef(oid) LIKE '%deal_assigned%'),
    'docs/deploy/ads-attribution.sql'
  UNION ALL
  SELECT
    '042 ads hardening',
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ad_entities' AND column_name = 'attempts')
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'ad_accounts' AND column_name = 'timezone'),
    'docs/deploy/ads-attribution.sql'
  UNION ALL
  SELECT
    '043 branding',
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'accounts' AND column_name = 'brand_name')
      AND EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'brand-assets'),
    'docs/deploy/branding.sql'
  UNION ALL
  SELECT
    '044 meta app per account',
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'whatsapp_config' AND column_name = 'webhook_token')
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'whatsapp_config' AND column_name = 'meta_app_secret_encrypted'),
    'docs/deploy/meta-app-per-account.sql'
  UNION ALL
  SELECT
    -- 045 tightens conversations_delete to owner-only and rewrites
    -- deals_conversation_id_fkey to ON DELETE SET NULL so a delete no
    -- longer fails against a linked deal — the FK action is the trace
    -- that's cheap to check from the catalog.
    '045 conversation owner delete',
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'deals_conversation_id_fkey'
        AND confdeltype = 'n'
    ),
    'docs/deploy/conversation-delete.sql'
  UNION ALL
  SELECT
    '047 owner-only settings',
    NOT EXISTS (
      SELECT 1 FROM information_schema.column_privileges
      WHERE grantee = 'authenticated'
        AND table_name = 'accounts'
        AND column_name = 'brand_name'
        AND privilege_type = 'UPDATE'
    ),
    'docs/deploy/owner-only-settings.sql'
  UNION ALL
  SELECT
    '048 brand display',
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'accounts' AND column_name = 'brand_display_mode')
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'accounts' AND column_name = 'brand_logo_size'),
    'docs/deploy/brand-display.sql'
  UNION ALL
  SELECT
    '049 contact tasks',
    to_regclass('public.contact_tasks') IS NOT NULL
      AND to_regprocedure('public.process_due_tasks()') IS NOT NULL,
    'docs/deploy/contact-tasks.sql'
  UNION ALL
  SELECT
    '050 calls',
    to_regclass('public.call_sessions') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'messages' AND column_name = 'call_outcome'),
    'docs/deploy/calls.sql'
  UNION ALL
  SELECT
    -- 051 is the one the app reads on EVERY page load (the account
    -- theme/mode the whole team shares). Missing it does not just
    -- disable appearance: the account select asks for these columns,
    -- fails, and the client falls back to a narrower column list — which
    -- is how a missing 051 also blanked brand_name / logo_url in the
    -- sidebar. The fallback is now progressive, but this row is still
    -- the fastest way to see the real cause.
    '051 account appearance',
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'accounts' AND column_name = 'theme')
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'accounts' AND column_name = 'mode'),
    'docs/deploy/account-appearance.sql'
  UNION ALL
  SELECT
    -- 034 stops the browser client from writing its own account_role /
    -- account_id. Without it a `viewer` promotes itself to `owner`, or
    -- moves into another tenant, with one PATCH -- both slip past the
    -- RLS policy because `user_id` never changes, and RLS constrains
    -- WHICH ROWS you may write, not WHICH COLUMNS.
    --
    -- This row exists because 034's own header admitted it had "not
    -- been run against a live database". It has now: see
    -- e2e/privilege-columns.spec.ts, and the manual PATCH below.
    --
    -- Both halves are checked. A trigger whose function was replaced by
    -- something inert would still show up in pg_trigger, so the guard
    -- clause inside the function is checked too.
    '034 profile privilege columns',
    EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal
        AND n.nspname = 'public' AND c.relname = 'profiles'
        AND t.tgname = 'enforce_profile_privilege_columns'
    )
    AND EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'enforce_profile_privilege_columns'
        AND p.prosrc LIKE '%account_role%'
        AND p.prosrc LIKE '%current_user%'
    ),
    'docs/deploy/profile-privilege-columns.sql'
  UNION ALL
  SELECT
    -- 052 is the only row here that checks an ABSENCE, and it is the
    -- one worth reading twice.
    --
    -- Postgres grants EXECUTE to PUBLIC on every function it creates,
    -- with nobody writing a line. A SECURITY DEFINER function bypasses
    -- RLS by design. Together that means any such function nobody
    -- revoked by hand is an RLS-bypassing write reachable with the
    -- `anon` key -- the one that ships inside the browser bundle.
    --
    -- Measured before the fix: a single anonymous POST to
    -- rpc/record_webhook_failure flipped another tenant's webhook
    -- endpoint from is_active=true to false.
    --
    -- MISSING here is not cosmetic drift. It means that project is
    -- currently exposed.
    '052 revoke EXECUTE from PUBLIC',
    NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef
        AND has_function_privilege('public', p.oid, 'EXECUTE')
    ),
    'docs/deploy/revoke-public-execute.sql'
)
SELECT
  c.release,
  CASE WHEN c.ok THEN 'APPLIED' ELSE 'MISSING -> run the bundle' END AS status,
  CASE
    WHEN r.version IS NOT NULL
      THEN 'registrado ' || to_char(r.applied_at, 'YYYY-MM-DD')
    WHEN c.ok THEN 'sin registrar'
    ELSE '-'
  END AS registro,
  c.bundle
FROM checks c
-- El numero al principio del nombre de la fila ('052 revoke ...') es la
-- version, que es como se registra cada migracion.
LEFT JOIN public.schema_release r
  ON r.version = substring(c.release from '^[0-9]{3}')
ORDER BY c.release;

-- ============================================================
-- Y el registro completo, incluidas las migraciones que este script no
-- comprueba una por una. Si esta vacio en un proyecto vivo, es que
-- nunca se aplico un bundle desde que existe el registro.
-- ============================================================
SELECT version, bundle, to_char(applied_at, 'YYYY-MM-DD HH24:MI') AS applied_at, applied_by
FROM public.schema_release
ORDER BY version;

-- ============================================================
-- APPLIED IS NOT THE SAME AS WORKING -- the one manual check
--
-- Every row above asks the catalog whether an object exists. For 034
-- that is necessary and not sufficient: a trigger can be present and
-- still not stop the attack (wrong role name in the guard, a policy
-- that shadows it, a PostgREST connection that does not run as
-- `authenticated`). The only honest confirmation is to try the attack.
--
-- Do this ONCE per client project, right after applying, with a real
-- non-owner user of that project signed in to the app. Take their
-- access token from the browser (Application -> Cookies, the
-- `sb-<ref>-auth-token` value) and run:
--
--   curl -i -X PATCH \
--     "https://<ref>.supabase.co/rest/v1/profiles?user_id=eq.<their-uuid>" \
--     -H "apikey: <ANON_KEY>" \
--     -H "Authorization: Bearer <THEIR_ACCESS_TOKEN>" \
--     -H "Content-Type: application/json" \
--     -d '{"account_role":"owner"}'
--
-- MUST return 403 with code 42501 and the message about the member /
-- invitation RPCs. Then confirm the legitimate path still works:
--
--   ... -d '{"full_name":"Same Name"}'      -> 204
--
-- If the first one returns 204, that project is exposed: any user with
-- a session can make themselves owner. Stop and fix before deploying.
--
-- Measured against the local stack (2026-09-09): 403/42501 for the
-- promotion, 403/42501 for the tenant hop, 204 for the name change,
-- 204 for `set_member_role` called by an owner.
-- ============================================================

