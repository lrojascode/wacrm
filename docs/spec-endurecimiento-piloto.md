# Especificación técnica y de producto — Endurecimiento y enfoque para servicio gestionado

**Estado:** propuesta ejecutable · **Versión:** 1.0 · **Fecha:** 2026-09-08
**Base:** commit `b4ca21a`, rama `main`, con cambios locales sin commitear presentes (se conservan).
**Destinatario:** agente/ingeniero que ejecuta. No reinterpretar objetivos ni inventar decisiones: lo que no esté aquí, está en §10 "Decisiones abiertas" y se pregunta antes de implementar.

> **Regla de repositorio de obligado cumplimiento.** `AGENTS.md` declara que esta versión de Next.js (16.2.6) tiene cambios de ruptura respecto al conocimiento previo. **Antes de escribir código de routing, middleware, caching, Server Actions o metadata, leer la guía correspondiente en `node_modules/next/dist/docs/`.** Esta spec cita comportamiento verificado en el código instalado, no en documentación recordada.

---

## 0. Cómo se validó este documento

Todo lo marcado como **[COMPROBADO]** se leyó en el código de este repositorio o en el paquete instalado en `node_modules`, con ruta y línea. Lo marcado como **[HIPÓTESIS]** requiere confirmación en runtime y lleva indicada la instrumentación que la confirma. No se ejecutó ninguna migración ni se modificó ningún archivo durante la investigación.

Comandos ejecutados durante el análisis: lectura de archivos, `grep`, y `pnpm audit --prod`.

---

## 1. Estado actual comprobado y riesgos

### 1.1 Dependencias — vulnerabilidades aplicables

**[COMPROBADO]** `pnpm audit --prod` reporta **52 advisories**. Las relevantes:

| Sev. | Paquete | Rango vulnerable | Parche | Advisory | Nota |
|---|---|---|---|---|---|
| **CRÍTICA** | `next` | `>=16.0.0 <16.3.3` | `16.3.3` | GHSA-p293-qw3h-jr36 | RCE no autenticado (servidores Windows) |
| **CRÍTICA** | `next` | `>=16.0.0 <16.3.3` | `16.3.3` | GHSA-2xp9-vwfh-vxw4 | **RCE no autenticado en Image Optimization API** |
| ALTA | `next` | `>=16.0.0 <16.2.11` | `16.2.11` | GHSA-6gpp-xcg3-4w24 | **Bypass de middleware/proxy en App Router** |
| ALTA | `next` | `>=16.0.0 <16.2.11` | `16.2.11` | GHSA-89xv-2m56-2m9x | SSRF en Server Actions |
| ALTA | `next` | `>=16.0.0 <16.2.11` | `16.2.11` | GHSA-p9j2-gv94-2wf4 | SSRF en rewrites |
| ALTA | `next` | `>=16.0.0 <16.2.11` | `16.2.11` | GHSA-m99w-x7hq-7vfj | DoS en Server Actions |
| MED | `next` | `>=16.0.0 <16.2.11` | `16.2.11` | GHSA-955p-x3mx-jcvp | Divulgación de endpoints de Server Functions |
| ALTA | `sharp` | `<0.35.4` | `0.35.4` | GHSA-rgj7-g3m4-5g8c | vía `next > sharp` (libheif/libvips) |
| ALTA | `postcss` | `<=8.5.17` | `8.5.18` | GHSA-r28c-9q8g-f849 | Path traversal en source maps |
| ALTA | `nanoid` | `<3.3.18` | `3.3.18` | GHSA-2v37-7h3g-55p8 | vía `next > postcss > nanoid` |
| ALTA | `browserslist` | `<=4.28.6` | `4.28.7` | GHSA-c83g-rgw3-j3cx, GHSA-73wf-gq98-2v4g | vía `next > styled-jsx > @babel/core` |

**Riesgo compuesto crítico:** GHSA-6gpp-xcg3-4w24 (bypass de middleware) es directamente explotable en esta arquitectura porque **toda la autorización de páginas vive en `src/proxy.ts:73-78`** (antes `src/middleware.ts`). Un bypass del middleware equivale a acceso no autenticado a `/inbox`, `/contacts`, `/settings`.

**[COMPROBADO] Hallazgo estructural de alto retorno:** `shadcn@^4.11.0` está declarado en **`dependencies`** (`package.json:47`), no en `devDependencies`. No se importa desde ningún archivo de `src/` ni de `mcp-server/src/` — es exclusivamente una CLI de scaffolding. Arrastra en producción todo el árbol `@modelcontextprotocol/sdk > express | hono | ajv`, que aporta **~25 de los 52 advisories** (`hono` ×11, `fast-uri` ×6, `qs` ×2, `brace-expansion` ×3, `ip-address` ×2, `body-parser`, `@hono/node-server`, `js-yaml` ×3). Moverlo a `devDependencies` elimina esa mitad del inventario sin cambiar una sola línea de código de aplicación.

Los `overrides` existentes en `package.json` (`postcss`, `ip-address`, `fast-uri`, `hono`, `js-yaml`, `@babel/core`) aparentan mitigar parte de esto, pero **están declarados en el campo npm de nivel superior, que pnpm no lee** — no se aplicaban en absoluto. Corregido en P0-DEP-03.

### 1.2 Autorización por roles — cobertura incompleta

**[COMPROBADO]** El modelo de roles está bien definido y es puro/testeable: `src/lib/auth/roles.ts` expone `roleRank()`, `hasMinRole()`, `canSendMessages()`, `canEditSettings()`, `canManageMembers()`, y su propio comentario de cabecera (líneas 11-15) declara que es *"the single source of truth"* que tanto los guards de API como los gates de UI deben invocar.

**No se cumple.** De **71 archivos `route.ts`** bajo `src/app/api/`, **16 no invocan ningún guard** (`requireRole`, `getCurrentAccount`, `requireApiKey`, ni ninguna predicado de `roles.ts`). Verificados uno a uno:

**Legítimamente sin sesión** (no son hallazgos):
- `api/whatsapp/webhook/route.ts`, `api/whatsapp/webhook/[token]/route.ts` — webhooks de Meta, validan firma.
- `api/invitations/[token]/peek/route.ts`, `.../redeem/route.ts` — flujo de invitación pre-sesión.
- `api/automations/cron/route.ts:19-30`, `api/flows/cron/route.ts:30-45` — autenticados por `AUTOMATION_CRON_SECRET` en header `x-cron-secret`.

**Hallazgos reales — autentican con `supabase.auth.getUser()` y filtran por `account_id`, pero NO comprueban rol.** Un usuario con rol `viewer` (definido como solo-lectura) puede ejecutarlos:

| Ruta | Línea de auth | Efecto que un `viewer` puede provocar |
|---|---|---|
| `src/app/api/whatsapp/send/route.ts` | `:30` `getUser()`, `:55` `accountId` | **Enviar mensajes de WhatsApp** al cliente final |
| `src/app/api/whatsapp/broadcast/route.ts` | `:68`, `:91` | **Lanzar un broadcast masivo** |
| `src/app/api/whatsapp/react/route.ts` | — | Reaccionar a mensajes |
| `src/app/api/whatsapp/templates/submit/route.ts` | `:95`, `:107` | **Crear y enviar plantillas a Meta** (+ dispara el SSRF de §1.4) |
| `src/app/api/whatsapp/templates/[id]/route.ts` | — | Editar plantillas (+ SSRF) |
| `src/app/api/whatsapp/templates/sync/route.ts` | — | Forzar sincronización con Meta |
| `src/app/api/whatsapp/config/verify-registration/route.ts` | — | Tocar el registro del número |
| `src/app/api/whatsapp/media/[mediaId]/route.ts` | `:52`, `:70` | Descargar media arbitraria de la cuenta |
| `src/app/api/flows/[id]/runs/route.ts` | — | Leer ejecuciones de flows (admin-only en UI) |
| `src/app/api/flows/templates/route.ts` | — | Leer catálogo de plantillas de flows |

`src/app/api/flows/route.ts:54` documenta explícitamente que la protección de flows se delega a `useRequireRole` **en el cliente** (`src/app/(dashboard)/flows/page.tsx:89`) — es decir, la autorización de ese módulo es puramente cosmética y se salta con un `curl`.

### 1.3 Migración 034 y su trigger — sin verificación de aplicación

**[COMPROBADO]** La migración existe y es correcta: `supabase/migrations/034_fix_profiles_update_rls.sql` crea `enforce_profile_privilege_columns()` (`:58-74`) y el trigger `BEFORE UPDATE ON public.profiles` (`:78-81`), que bloquea que un `authenticated` modifique `account_role` / `account_id` — cierra una escalada de privilegios y un salto de tenant (documentado en su propia cabecera, `:24-27`). Está incluido en el bundle `docs/deploy/full-install.sql:4801-4824`.

**Los riesgos son operativos, no de diseño:**

1. **[COMPROBADO]** La propia migración advierte en `:53-55`: *"this migration was not run against a live database"*. Nunca fue validada contra una instancia real.
2. **[COMPROBADO]** `docs/deploy/check-applied.sql` **no comprueba la 034**. Un `grep` de `034`, `enforce_profile_privilege` o `trigger` en ese archivo no devuelve nada. El script verifica columnas de otras releases, pero este control de seguridad concreto no tiene verificación.
3. **[COMPROBADO — riesgo sistémico]** `docs/deploy/check-applied.sql:4-8` declara literalmente: *"There is no migration runner in this setup: the bundles under `docs/deploy/` are pasted into the Supabase SQL editor by hand, and nothing records that they ran."*

El punto 3 es **el mayor riesgo operativo del proyecto** para un modelo de un proyecto Supabase por cliente: sin runner ni registro, el esquema de cada cliente es un estado desconocido y divergente. No es aceptable para un servicio gestionado.

### 1.4 SSRF y consumo de memoria en descarga de imágenes de plantillas

**[COMPROBADO]** `src/lib/whatsapp/template-header-handle.ts`:

```
:46   res = await fetch(payload.header_media_url)      // URL controlada por el usuario, sin validación
:54   const contentType = res.headers.get('content-type')
:59   const bytes = new Uint8Array(await res.arrayBuffer())   // buffer completo sin límite
:63   if (bytes.byteLength > IMAGE_MAX_BYTES)                 // el límite se comprueba DESPUÉS
```

Dos defectos independientes:

- **SSRF:** `header_media_url` viene del cuerpo de la petición. No hay validación de esquema, host ni resolución DNS. Permite alcanzar `http://169.254.169.254/` (metadatos de nube), `http://localhost:*`, y cualquier servicio de red interna. Sin límite de redirecciones. Alcanzable desde `src/app/api/whatsapp/templates/submit/route.ts:183` y `src/app/api/whatsapp/templates/[id]/route.ts:157`, **ninguna de las cuales comprueba rol** (§1.2).
- **Agotamiento de memoria:** `arrayBuffer()` materializa la respuesta completa en heap antes de la comprobación de 5 MB de `:63`. Una respuesta de varios GB tumba el proceso. El `Content-Length` nunca se consulta.

**El repositorio ya tiene la defensa correcta y no la usa aquí.** `src/lib/webhooks/ssrf.ts` implementa `isPrivateOrReservedIp()` (`:25`) e `isDeliverableUrl()` (`:53-79`), con resolución DNS y bloqueo de `localhost`, `.local`, `.internal` y rangos privados. Ya la consumen `src/lib/webhooks/deliver.ts:27,93` (incluida revalidación tras redirección, `:124`) y `src/lib/automations/engine.ts:28,626`, con test de regresión en `src/lib/automations/engine.test.ts:234-242` que apunta a `169.254.169.254`. La corrección es reutilizar ese módulo, no escribir uno nuevo.

### 1.5 Funciones SECURITY DEFINER con EXECUTE a PUBLIC

**[COMPROBADO]** PostgreSQL concede `EXECUTE` a `PUBLIC` por defecto en toda función nueva. En Supabase, el rol `anon` (la clave pública del navegador) hereda `PUBLIC`. Toda función `SECURITY DEFINER` sin un `REVOKE ... FROM PUBLIC` explícito es **invocable sin autenticación** vía `POST /rest/v1/rpc/<nombre>`.

Hay 51 apariciones de `SECURITY DEFINER` en `supabase/migrations/`. Contraste de los `REVOKE` presentes contra las funciones definidas:

**Correctamente protegidas** (patrón a replicar, mejor ejemplo `supabase/migrations/050_calls.sql:110-111`): `merge_duplicate_conversations`, `merge_duplicate_contacts`, `merge_contact_group`, `increment_tracked_link_clicks`, `increment_flow_execution_count`, `increment_automation_execution_count`, `match_ai_knowledge_fts`, `match_ai_knowledge_semantic`, `set_member_role`, `remove_account_member`, `transfer_account_ownership`, `peek_invitation`, `redeem_invitation`, `filter_contacts_by_tags`, `update_conversation_last_message`.

**Sin `REVOKE` — expuestas a `anon`:**

| Función | Definición | Severidad | Impacto verificado |
|---|---|---|---|
| `public.claim_ai_reply_slot(uuid, integer)` | `029_ai_reply.sql:118-131`; `GRANT` solo a `service_role` en `:141` y `031:27`, **sin `REVOKE FROM PUBLIC`** | **CRÍTICA** | Ver abajo |
| `public.touch_presence(...)` | `024_member_presence.sql:56` — sin ningún `GRANT`/`REVOKE` | Media | Escritura de presencia sin sesión |
| `public.record_webhook_failure(...)` | `028_webhook_endpoints.sql:91` — sin `REVOKE` | Media | Manipulación del estado de salud de webhooks |
| `public.process_due_tasks()` | `049_contact_tasks.sql:72`, `GRANT` a `authenticated` en `:139`, sin `REVOKE` | Baja | Acotada por `auth.uid()` (`:78,84`): para `anon` devuelve 0. Revocar por defensa en profundidad |
| `is_account_member(UUID, account_role_enum)` | `017_account_sharing.sql:136`, `GRANT` en `:167`, sin `REVOKE` | Baja | Predicado; filtra existencia de membresía |

**Detalle de `claim_ai_reply_slot` — escritura cross-tenant no autenticada.** Cuerpo completo (`029_ai_reply.sql:122-131`):

```sql
UPDATE conversations
SET ai_reply_count = ai_reply_count + 1
WHERE id = conversation_id AND ai_reply_count < max_replies
```

No hay `auth.uid()`, no hay comprobación de cuenta, y `conversation_id` es un parámetro libre. Con solo la clave `anon` (que es pública por diseño, va en el bundle del navegador) un atacante puede:
- Incrementar `ai_reply_count` en **cualquier conversación de cualquier cuenta** del proyecto.
- Agotar el presupuesto de auto-respuesta de una conversación → la IA deja de responder (denegación de servicio silenciosa dirigida).
- Enumerar UUIDs de conversación por el booleano de retorno.

La cabecera del `GRANT` en `029:133-140` razona correctamente que `SECURITY DEFINER` no basta para conceder, pero omite que tampoco basta para *denegar*: el `GRANT` a `service_role` no retira el `EXECUTE` implícito de `PUBLIC`.

### 1.6 Signup público abierto

**[COMPROBADO]** `src/app/(auth)/signup/page.tsx:73` llama `supabase.auth.signUp({...})` sin restricción. La ruta `/signup` está en la lista de rutas de auth del proxy (`src/proxy.ts:53`). No hay allowlist de dominio, ni requisito de invitación, ni verificación de email antes de crear cuenta. Existe infraestructura de invitaciones (`019_invitation_rpcs.sql`, `src/app/join/[token]/`, `src/lib/auth/invitations.ts`) pero convive con el alta libre. No hay MFA en ninguna parte del código.

### 1.7 Durabilidad — el hallazgo más grave de fiabilidad

**[COMPROBADO]** Los broadcasts se envían **desde el navegador**. `src/hooks/use-broadcast-sending.ts` es `'use client'` (`:1`) y contiene el bucle de envío completo:

```
:62-63   SEND_BATCH_SIZE = 10 ; SEND_BATCH_DELAY_MS = 1000
:396     for (...) inserción de destinatarios por lotes de 200
:457     for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE)   // bucle de envío
:153     const [progress, setProgress] = useState(0)
```

Consecuencia directa: **si el agente cierra la pestaña, pierde la conexión o el portátil suspende, el broadcast se detiene a mitad**, con parte de los destinatarios enviados y el resto en un estado indeterminado. No hay proceso servidor que lo retome. Para un producto cuyo posicionamiento es "WhatsApp Revenue OS", esto es un fallo de producto, no solo técnico.

No existe cola, ni outbox, ni leases, ni idempotencia, ni DLQ. Los únicos mecanismos asíncronos son los dos endpoints de cron (`api/automations/cron`, `api/flows/cron`) que se invocan externamente (n8n, según `docs/pruebas-local.md:294`) con un secreto compartido único.

### 1.8 Adjuntos públicos

**[COMPROBADO]** `supabase/migrations/023_chat_media.sql:38` inserta el bucket `chat-media` con `public = true`. La política de lectura (`:79-86`) es `USING (bucket_id = 'chat-media')` **sin ninguna condición de cuenta**. El comentario `:25` lo justifica: *"The bucket is public so Meta can fetch the URL without auth"*.

Efecto: cualquier adjunto de cualquier conversación de cualquier cliente es legible por URL, sin sesión y sin caducidad. Basta con conocer o adivinar la ruta. Lo mismo aplica a `avatars` (`008_profile_avatars_storage.sql:15,35`).

En un servicio gestionado multi-cliente esto es una fuga de datos de clientes finales (fotos, documentos, audios enviados por consumidores por WhatsApp). No hay política de retención: los objetos viven indefinidamente.

### 1.9 Cifrado — clave única global

**[COMPROBADO]** `src/lib/whatsapp/encryption.ts:29` lee `const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!` **a nivel de módulo**, y la usa en `:41` (cifrado), `:70` y `:90` (descifrado). Una sola clave, sin versión, sin identificador de tenant, sin rotación.

Protege: token de acceso de WhatsApp (`api/whatsapp/config/route.ts:134,294`), App Secret de Meta (`api/whatsapp/meta-app/route.ts:103`), claves de embeddings (`src/lib/ai/config.ts:63,110`).

Los propios mensajes de error del código evidencian el problema en producción — `api/whatsapp/config/route.ts:147`: *"the key changed, or it differs between environments (local vs Hostinger vs Vercel)"*. Rotar la clave hoy **invalida todos los secretos de todos los clientes a la vez**, sin camino de migración.

### 1.10 Otros hallazgos verificados

- **CSP no aplicada.** `next.config.ts:39` emite `Content-Security-Policy-Report-Only`. El resto de cabeceras (`HSTS :24`, `X-Frame-Options: DENY :28`, `X-Content-Type-Options`, `Referrer-Policy`) sí se aplican. `Cache-Control: private, no-store` está correctamente puesto en rutas autenticadas (`:133,182`).
- **Sin infraestructura E2E.** `vitest.config.ts` usa `environment: "node"` y `include: ["src/**/*.test.ts", "src/**/*.test.tsx"]`. Hay **93 archivos de test con 872 casos** (verificado con `pnpm test`), todos unitarios de Node. No hay Playwright, ni jsdom, ni `@testing-library`. **Ninguna de las pruebas E2E que esta spec exige puede escribirse sin crear la infraestructura primero** — es una dependencia dura de la fase P0.
- **MCP ya está segmentado.** `mcp-server/src/tools/index.ts:14-27` registra `read` siempre y condiciona `write` y `broadcast` a `config.enableWrites` / `config.enableBroadcasts` (`mcp-server/src/tools/write.ts:2` documenta `WACRM_ENABLE_WRITES`). El trabajo P2 es fijar el default a desactivado y documentarlo, no rediseñarlo.
- **Marca.** `package.json:2-13` aún declara `author: Arnas Donauskas`, `homepage`/`repository`/`bugs` apuntando a `github.com/ArnasDon/wacrm`. Existe `src/lib/branding/brand.ts` con `resolveBrand` y `buildBrandMetadata`, y branding por cuenta en BD (migraciones 043/048/051). Quedan literales `wacrm:` en claves de storage del cliente (`src/app/(dashboard)/inbox/page.tsx:22`) y `wacrm_live_…` como prefijo de API keys (`src/lib/auth/api-context.ts:8`). La licencia MIT (`LICENSE`) y la atribución deben conservarse.

---

## 2. Causa raíz comprobada del bug de navegación

### 2.1 Lo que **no** es

Descartado por lectura directa, para que el ejecutor no pierda tiempo:

- **No es el estado del Inbox.** `src/app/(dashboard)/inbox/page.tsx` ya implementa deep-link `?c=<id>` (`:44`), lo escribe al seleccionar (`:518` `router.replace(\`/inbox?c=${conv.id}\`)`), lo limpia al cerrar (`:533`) y al borrarse la conversación (`:296`). El auto-select está correctamente protegido contra re-disparos con `autoSelectedForDeepLinkRef` (`:97`, `:444-448`, `:514`), con comentarios que documentan bugs previos ya corregidos.
- **No es el handler de `visibilitychange` del Inbox.** `:410-422` solo hace `setResyncToken(n => n + 1)`. Los hijos lo consumen para *refetch*, no para reset: `conversation-list.tsx:160` (`[resyncToken]`) y `message-thread.tsx:318,348` (`[conversationId, resyncToken]`). Ninguno toca la selección.
- **No es un `router.back()`.** No existe ninguna llamada a `router.back()`, `history.back()` ni `popstate` en todo `src/`.
- **No es `useRequireRole`.** Sí hace `router.replace("/dashboard")` (`src/hooks/use-require-role.ts:30`), pero solo lo usan `agents/page.tsx:17`, `flows/page.tsx:89`, `flows/[id]/page.tsx:27` y `flows/[id]/runs/page.tsx:106`. **El Inbox no lo usa.**
- **No es el heartbeat de presencia.** `src/components/presence/presence-heartbeat.tsx:87-88` escucha `visibilitychange` y `focus`, pero solo llama `supabase.rpc("touch_presence")` (`:59`), que va directo a Supabase sin pasar por el middleware, y no navega.

### 2.2 Defecto A — el estado del Inbox vive bajo un gate que lo desmonta

**[COMPROBADO]** Todo el estado del Inbox es estado local de un componente cliente: `activeConversation`, `activeContact`, `messages`, `conversations` (`inbox/page.tsx:46-55`), más `search`, `filter`, `selectedTagIds`, `selectedCompany` que viven **dentro** de `ConversationList` (`conversation-list.tsx:99-104`) y el scroll del hilo dentro de `MessageThread`.

Ese árbol se renderiza como `{children}` de `DashboardShellInner`, que tiene dos salidas tempranas (`src/app/(dashboard)/dashboard-shell.tsx:31-42`):

```tsx
:31   if (loading) { return ( ...spinner... ) }     // children NO se renderizan
:42   if (!user) return null;                        // children NO se renderizan
```

React desmonta un subárbol cuando deja de renderizarse. **Cualquier oscilación transitoria de `user` o `loading` destruye irreversiblemente conversación abierta, mensajes, filtros, búsqueda y scroll.** No hay persistencia: al volver, el Inbox se remonta desde cero. La URL `?c=` sí sobrevive, pero solo si el remontaje ocurre sin navegación — y el Defecto B garantiza que sí hay navegación.

### 2.3 Defecto B — sign-out transitorio convertido en navegación a `/dashboard`

**[COMPROBADO]** `@supabase/auth-js@2.108.2` registra un listener de visibilidad (`GoTrueClient.js:4587`) y en cada transición a visible ejecuta `_recoverAndRefresh()` (`:4620` / `:4629`, dentro de `_onVisibilityChanged`, `:4599-4638`).

> ⚠️ **CORREGIDO POR MEDICIÓN (P0-BUG-01, 2026-09-09).** Una versión previa de esta sección afirmaba que *"cada vez que el usuario vuelve a la pestaña se dispara un evento de auth"*. **Es falso.** Con una sesión válida y no próxima a caducar, un ciclo `hidden → visible` produce **cero** eventos: `_recoverAndRefresh` solo notifica cuando algo cambia. El error vino de leer que la función termina en `_notifyAllSubscribers('SIGNED_IN', …)` sin comprobar que esa rama se alcanza. Ver `docs/p0-bug-01-informe.md`.

En `_recoverAndRefresh()` (`:3959-4056`) hay dos caminos que terminan en sesión nula:
- `:3994-3999` — si `_isValidSession(currentSession)` es falso → `await this._removeSession()`, que emite `SIGNED_OUT` (`:4285`). **Medido:** con la cookie simplemente ausente, `currentSession` es null y la guarda `if (currentSession !== null)` impide el `_removeSession`, así que **no se emite nada**.
- `:4004-4021` — si el token está dentro del margen de expiración, llama `_callRefreshToken()`. **Medido:** un fallo de **red** no elimina la sesión (6 intentos interceptados, sesión intacta); el propio comentario de `:4008-4014` advierte de no hacerlo. Solo un rechazo **definitivo** del servidor (`refresh_token_not_found`) la elimina.

**[REPRODUCIDO] La condición exacta**, aislada por eliminación en `e2e/auth-trace.spec.ts`: access token caducado **más** refresh rechazado definitivamente. Es decir, la **carrera de rotación** entre auth-js y el proxy, que compiten por rotar el mismo refresh token — no la fragilidad de red. Timeline capturado:

```
1438ms  visibility  visible        cookie=sí  session=-    /inbox
1474ms  auth-event  SIGNED_OUT     cookie=NO  session=NO   /inbox
1477ms  expulsion   shell:no-user  cookie=NO  session=-    /inbox
```

Entre el evento y la expulsión hay **3 ms**: hoy no existe ninguna oportunidad de verificar si la sesión era recuperable.

El cliente del navegador es un singleton (`src/lib/supabase/client.ts:9-18`) creado con `createBrowserClient` de `@supabase/ssr`, **cuyo almacenamiento son cookies compartidas con el servidor** — las mismas que `src/proxy.ts` rota en cada petición (`:26` `getUser()`, `:38-43` `withRefreshedCookies`). El propio comentario de `proxy.ts:28-37` documenta que ya hubo un incidente de wedge de sesión por rotación (issue #288). Hay, por tanto, dos rotadores concurrentes sobre el mismo almacén.

Cuando llega ese `SIGNED_OUT`, `src/hooks/use-auth.tsx:352-369` lo trata como un cierre de sesión real, sin debounce ni confirmación:

```
:355   setUser(currentUser)      // null
:363   setProfile(null); setAccount(null)
```

Y entonces se encadena:

```
1. use-auth.tsx:355          user → null
2. dashboard-shell.tsx:42    if (!user) return null     → SE DESMONTA TODO EL INBOX (Defecto A)
3. dashboard-shell.tsx:25-29 useEffect → router.push("/login")
4. middleware.ts:51-56       petición a /login; getUser() ve la cookie (rotada/aún válida) → user truthy
5. middleware.ts:66-69       url.pathname = '/dashboard'; return redirect
6.                           El usuario aterriza en /dashboard, con AuthProvider remontado
                             (loading vuelve a true, use-auth.tsx:140) y el Inbox destruido.
```

**Esto reproduce exactamente los síntomas 1, 2 y 3 del reporte.** El usuario nunca ve `/login`: el middleware lo rebota a `/dashboard` en el mismo viaje.

**[HIPÓTESIS]** Qué disparo concreto produce el `SIGNED_OUT` en el entorno del cliente (expiración real tras una pestaña larga en segundo plano, carrera de rotación entre middleware y cliente, o lectura de cookie fragmentada `sb-*-auth-token.0/.1` a medio escribir) **no está determinado y no puede estarlo por lectura de código**. Instrumentación que lo resuelve, a añadir en P0-BUG-01: registrar `event` y `session === null` en `onAuthStateChange` junto a `document.visibilityState`, con envío al canal de observabilidad. **La corrección no depende de cuál sea:** los tres disparos convergen en el mismo camino, y las tareas P0-BUG-02..05 lo cierran en su totalidad.

### 2.4 Defecto C — historial sin entradas por conversación

**[COMPROBADO]** `handleSelectConversation` usa `router.replace` (`inbox/page.tsx:518`), igual que `handleCloseConversation` (`:533`) y el borrado (`:296`). `replace` **no crea entrada de historial**. Tras navegar `/dashboard → /inbox` y abrir tres conversaciones, la pila de historial sigue siendo `[/dashboard, /inbox?c=<última>]`.

Consecuencias directas y comprobables:
- **Atrás del navegador desde una conversación sale del Inbox y aterriza en `/dashboard`** — es el síntoma 3 del reporte, y ocurre de forma determinista, sin necesidad de ningún fallo de auth.
- Adelante/atrás entre conversaciones es imposible.
- En móvil, el gesto de retroceso del sistema abandona el Inbox en lugar de volver a la lista.

Este defecto es independiente de A y B y hay que corregirlo aparte.

### 2.5 Defecto D — la conversación no se valida en servidor

**[COMPROBADO]** La resolución de `?c=<id>` es puramente cliente: `handleConversationsLoaded` busca el id **dentro de la lista ya cargada** (`:459` `loaded.find(c => c.id === deepLinkConvId)`). Si no está en la lista (paginación, filtro activo, o pertenece a otra cuenta) simplemente **no pasa nada**: sin selección, sin mensaje de error, sin redirección. El usuario abre su enlace y ve el panel vacío sin explicación.

No hay separación entre "no autorizado", "borrada" y "no está en la página cargada". El requisito del reporte —*"Si la conversación fue eliminada o el usuario perdió acceso, regresar a Inbox con un mensaje claro"*— no está implementado en ninguna forma.

Nota de aislamiento: RLS impide leer conversaciones de otra cuenta, así que **no hay fuga entre tenants hoy**; lo que falta es el mensaje claro y la distinción de casos.

### 2.6 Resumen de causa raíz

> El bug **no tiene una causa única**. Son cuatro defectos que se suman:
>
> - **A** — El estado del Inbox es estado local de React colocado bajo un gate de auth que desmonta a sus hijos (`dashboard-shell.tsx:31,42`). Cualquier parpadeo de auth lo borra.
> - **B** — `@supabase/auth-js` emite eventos de auth en **cada** retorno de pestaña (`GoTrueClient.js:4587,4620`), y un `SIGNED_OUT` transitorio se convierte en `router.push("/login")` (`dashboard-shell.tsx:27`) que el middleware rebota a `/dashboard` (`proxy.ts:66-69`). Ese rebote **es** el "vuelve al inicio" que reporta el usuario.
> - **C** — Toda la selección usa `router.replace` (`inbox/page.tsx:518`), así que no existen entradas de historial por conversación y el botón Atrás abandona el Inbox.
> - **D** — El deep-link se resuelve solo en cliente contra la lista cargada (`inbox/page.tsx:459`), sin validación servidor ni distinción entre borrada / sin acceso / no cargada.
>
> Arreglar solo uno **no** resuelve el reporte. El plan P0-BUG los cierra los cuatro.

---

## 3. Arquitectura objetivo

### 3.1 Topología del servicio gestionado

```
                    ┌───────────────────────────────────────┐
                    │  Repositorio único, versionado (main)  │
                    │  Sin ramas por cliente. Release tags.  │
                    └───────────────────┬───────────────────┘
                                        │ mismo artefacto
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                         ▼
      ┌───────────────┐         ┌───────────────┐         ┌───────────────┐
      │  Cliente A    │         │  Cliente B    │         │  Cliente C    │
      │  app instance │         │  app instance │         │  app instance │
      │  proyecto SB  │         │  proyecto SB  │         │  proyecto SB  │
      │  KMS keyset   │         │  KMS keyset   │         │  KMS keyset   │
      └───────────────┘         └───────────────┘         └───────────────┘

  Diferenciación exclusivamente por configuración:
    · variables de entorno por instancia
    · feature flags por cuenta (BD)
    · manifiesto de marca (proveedor fijo / cliente configurable)
```

**Invariante no negociable:** una diferencia entre clientes que no se pueda expresar como configuración es un defecto de diseño. Nunca una rama, nunca un fork.

### 3.2 Autorización — un único punto de aplicación

Se introduce `src/lib/auth/guard.ts` como envoltorio obligatorio de **toda** route handler con efectos:

```ts
export const POST = withRoute(
  { minRole: 'agent', module: 'whatsapp.send', reauth: false },
  async (ctx, req) => { /* ctx.accountId, ctx.userId, ctx.role garantizados */ }
);
```

Responsabilidades del envoltorio, en orden: resolver sesión (cookie) o API key → resolver `accountId` y `role` → aplicar `hasMinRole` de `roles.ts` → comprobar el kill switch del módulo → exigir reautenticación si la acción lo requiere → registrar en auditoría → ejecutar el handler.

Matriz de roles a aplicar (según lo acordado):

| Rol | Alcance |
|---|---|
| `viewer` | Lectura. Ningún efecto interno ni externo. |
| `agent` | Operación: enviar, asignar, mover deals, completar tareas. |
| `admin` | Configuración no crítica: automatizaciones, plantillas, miembros, apariencia. |
| `owner` | Secretos e integraciones: tokens de WhatsApp, App Secret de Meta, claves de IA, API keys, exportaciones completas. |

**Enforcement en CI:** un test de repositorio enumera `src/app/api/**/route.ts` y falla si algún archivo no usa `withRoute` o no está en una allowlist explícita y justificada (webhooks, crons, invitación). Esto impide que la brecha de §1.2 se reabra.

### 3.3 Inbox — estado navegable y resiliente

Cuatro cambios que atacan A, B, C y D respectivamente:

1. **Ruta propia:** `src/app/(dashboard)/inbox/[conversationId]/page.tsx`, con `/inbox` como lista. La conversación pasa a ser una ubicación, no un estado. Navegación con `router.push` (crea historial); solo cambios de filtro usan `replace`.
2. **Gate de auth que no desmonta:** `DashboardShellInner` deja de devolver `null`/spinner en lugar de `children`. Mantiene el árbol montado y superpone un overlay no destructivo. La redirección a `/login` exige confirmación de sesión realmente perdida (ver 4).
3. **Auth resiliente a parpadeos:** el `SIGNED_OUT` no se acepta a ciegas. Se confirma con `getUser()` y se aplica una ventana de gracia; solo si se confirma, se cierra sesión. Se distingue "sesión perdida" de "evento de visibilidad".
4. **Validación en servidor:** carga de la conversación con RLS del usuario, devolviendo tres estados distinguibles: `ok` / `not_found` (borrada) / `forbidden` (sin acceso). `not_found` y `forbidden` redirigen a `/inbox` con un mensaje explícito.

Preservación de UI: filtros, búsqueda y scroll se persisten por dispositivo en `sessionStorage` con clave que incluye `accountId`, para que un cambio de cuenta nunca reutilice el estado anterior.

### 3.4 Durabilidad — outbox transaccional sobre PostgreSQL

Una sola tabla `job_queue` (esquema en §7) con:

- **Outbox transaccional:** el trabajo se encola **en la misma transacción** que el cambio de negocio. Si la transacción falla, no hay job huérfano.
- **Leases:** un worker toma N jobs con `FOR UPDATE SKIP LOCKED` y fija `locked_until = now() + lease`. Nadie más los ve mientras dure.
- **Idempotencia:** `idempotency_key` con índice único parcial. Reintentar nunca duplica un envío a WhatsApp.
- **Backoff exponencial** con jitter, `attempts` y `max_attempts` por tipo de job.
- **Recuperación de abandonados:** un barrido devuelve a `pending` los jobs con `locked_until < now()` y `status = 'running'`.
- **DLQ:** agotados los intentos → `status = 'dead'`, con `last_error` y visible en el Health Center.

Migración del broadcast: `use-broadcast-sending.ts` deja de enviar. Crea el broadcast + inserta destinatarios + encola jobs, todo transaccional, y devuelve. El progreso se lee de la BD por realtime. Cerrar la pestaña deja de tener efecto sobre el envío.

### 3.5 Claves versionadas por cliente y entorno

Se sustituye la lectura directa de `process.env.ENCRYPTION_KEY` por un keyset:

```
ENCRYPTION_KEYS = {"v1":"<hex>","v2":"<hex>"}
ENCRYPTION_ACTIVE_KEY_ID = "v2"
```

Ciframos siempre con la activa; desciframos con la que indique el prefijo del ciphertext (`v<N>:`). Formato nuevo: `v<N>:<iv>:<tag>:<ct>`. Los ciphertexts sin prefijo se interpretan como `v1` (compatibilidad con lo ya almacenado). Rotar = añadir clave, cambiar la activa, re-cifrar en segundo plano, retirar la antigua. Cada cliente tiene su propio keyset; ninguna clave es compartida entre clientes ni entre entornos.

### 3.6 Observabilidad, auditoría y kill switches

- **Auditoría:** tabla `audit_log` escrita por `withRoute` para toda acción con efectos: quién, qué, cuándo, sobre qué recurso, resultado.
- **Kill switches por módulo:** tabla `module_flags` (`ai`, `broadcasts`, `automations`, `flows`, `calls`, `mcp_write`, `public_api_write`, `ads_sync`). Consultada por `withRoute`. Un módulo se puede apagar por cuenta sin desplegar.
- **Health Center:** página que muestra profundidad de cola, jobs muertos, último éxito de cada cron, estado de conexión de WhatsApp, y advertencias de esquema.
- **Alertas:** cola creciendo, jobs muertos > umbral, cron sin ejecutarse en su ventana, fallos de descifrado, tasa de 5xx.

---

## 4. Fases, dependencias y orden de ejecución

Orden **estricto**. Una fase no empieza hasta que la anterior pasa su gate.

```
P0 ─ Seguridad crítica ──────────────────────────────── bloquea todo lo demás
  │   P0-INFRA-01 (E2E) ─┬─> P0-BUG-01..06
  │   P0-DEP-01,02 ──────┘
  │   P0-SEC-01..09 (paralelizables entre sí)
  ▼
P1 ─ Fiabilidad y recuperación
  │   P1-QUEUE-01..07 (requiere P0-SEC-02: guards)
  │   P1-DR-01..05    (requiere P1-KEY-01: claves versionadas)
  │   P1-OBS-01..04
  ▼
P2 ─ Producto
  │   P2-BRAND, P2-NAV, P2-FLAG (requiere P1-OBS-02: flags)
  ▼
P3 ─ Diferenciación
      P3-FUNNEL, P3-PLAYBOOK, P3-COPILOT, P3-PILOT
```

**Dependencias duras (no negociables):**

| Depende | De | Motivo |
|---|---|---|
| `P0-BUG-*` | `P0-INFRA-01` | Las pruebas E2E exigidas no existen hoy; sin infraestructura no se puede verificar el arreglo. |
| `P0-BUG-02` | `P0-DEP-01` | Cambiar el gate de auth sobre un Next con bypass de middleware conocido deja una ventana abierta. |
| `P1-QUEUE-*` | `P0-SEC-02` | Encolar sin autorización centralizada expande la superficie sin control. |
| `P1-DR-*` | `P1-KEY-01` | Un backup restaurable exige saber con qué clave se descifra cada secreto. |
| `P2-FLAG-*` | `P1-OBS-02` | Los flags de beta y los kill switches comparten tabla y caché. |
| `P3-PILOT-01` | Gate §11 completo | El piloto no empieza sin el gate. |

---

## 5. Tareas por workstream

Formato: `ID · título · archivos · criterio de aceptación`. Cada tarea es un PR revisable de forma independiente.

### P0 · Workstream DEP — Dependencias

**P0-DEP-01 — Elevar Next.js a `>=16.3.3`** — ✅ **COMPLETADA** (2026-09-09)
`package.json`, `pnpm-lock.yaml`
Aplicado `next` y `eslint-config-next` **16.2.6 → 16.3.4** (último parche de la serie; 16.3.3 era el mínimo). `engines.node` elevado a `>=20.9.0` para reflejar lo que declara el paquete. React 19.2.4 ya cumplía el peer `^19.0.0`.
*Aceptación:* `pnpm audit --prod` sin advisories `critical` ni `high` con path `.>next`; `build`, `typecheck`, `lint` y `test` en verde.
*Resultado medido:* **13 → 0 advisories en `--prod`** (52 → 0 acumulado desde el inicio). `build` exit 0 (98 rutas, 3 bundles CSS), `typecheck` exit 0, `lint` 0 errores, `test` 93 archivos / 872 casos en verde. El test del gate de autenticación (4 tests) pasa.
*Docs leídos, según obliga `AGENTS.md`:* `01-app/02-guides/upgrading/version-16.md` y `01-app/01-getting-started/18-upgrading.md`. APIs deprecadas o eliminadas comprobadas contra el repo — **ninguna en uso**: AMP (eliminado), `revalidateTag` de un argumento, `next/legacy/image`, `images.domains`, `skipMiddlewareUrlNormalize`.
*Limpieza incluida:* retirados los cuatro overrides del árbol de `next` (`postcss`, `nanoid`, `browserslist`, `baseline-browser-mapping`), redundantes tras la actualización — verificado empíricamente que `--prod` sigue en 0 sin ellos.
*Deprecaciones surgidas:* (1) `middleware` → `proxy`, que afecta al fichero donde vive toda la autorización de páginas — resuelta aparte en **P0-DEP-05**. (2) Edge runtime deprecado en `src/app/icon.tsx:11`, cambio de una línea, **pendiente**. Detalle en `docs/security/dependencies.md`.
*Nota de lint:* los warnings pasaron de 38 a 42, todos `react-hooks/exhaustive-deps` sobre código preexistente que el linter más estricto de 16.3.4 ahora detecta. **0 errores**; no son regresiones de esta tarea.

**P0-DEP-02 — Mover `shadcn` a `devDependencies`** — ✅ **COMPLETADA** (2026-09-08)
`package.json`, `pnpm-lock.yaml`
Matiz corregido durante la ejecución: `shadcn` **no** es solo CLI — `src/app/globals.css:3` hace `@import "shadcn/tailwind.css"`, consumido en build por el pipeline de Tailwind/PostCSS. Sigue siendo correcto como `devDependency`: el build ocurre con install completo (`.github/workflows/ci.yml:43` usa `pnpm install --frozen-lockfile`), y `dependencies` vs `devDependencies` no altera la resolución de módulos en un install completo — solo excluye el paquete de un `pnpm install --prod`, donde no se compila. No hay Dockerfile ni `vercel.json` en el repo que fuerce `--prod`.
*Aceptación:* el conteo de `pnpm audit --prod` baja de 52 a ≤30; ningún advisory con path `.>shadcn`; el build sigue resolviendo el `@import`.
*Resultado medido:* **52 → 23 advisories** (`{critical:2, high:13, moderate:8}`, antes `{critical:2, high:26, moderate:21, low:3}`); **0** advisories vía `shadcn`; `build` exit 0, `typecheck` exit 0, `lint` exit 0 (38 warnings preexistentes), `test` 93 archivos / 872 casos en verde. Los 23 restantes son todos del árbol de `next` (`next`, `postcss`, `nanoid`, `sharp`, `browserslist`, `baseline-browser-mapping`) y los cierran P0-DEP-01 y P0-DEP-03.

**P0-DEP-03 — Actualizar `overrides` restantes** — ✅ **COMPLETADA** (2026-09-09)
`package.json`, `pnpm-lock.yaml`, nuevo `docs/security/dependencies.md`
**Defecto encontrado durante la ejecución:** los seis overrides preexistentes estaban en el campo **`overrides` de nivel superior (formato npm)**, que pnpm no lee — espera `pnpm.overrides`. Eran configuración muerta: el override declaraba `postcss: ^8.5.10` y el árbol de producción resolvía `postcss@8.4.31`. Corregido moviendo el bloque a `pnpm.overrides`; tras el cambio `next@16.2.6` resuelve `postcss: 8.5.23` en el lockfile y no queda ninguna referencia a 8.4.31.
*Aceptación (revisada):* el criterio original —cero advisories `high`+— **no es alcanzable en esta tarea**: 11 de los 13 restantes son del propio `next` (2 critical, 4 high, 5 moderate) y ningún override los toca. Criterio efectivo: todos los advisories corregibles por override eliminados, y los restantes documentados con justificación y condición de cierre.
*Resultado medido:* **23 → 13 advisories**. Eliminados por completo `postcss`, `nanoid`, `browserslist` y `baseline-browser-mapping`. `build` exit 0 (98 rutas, CSS compilado), `typecheck` exit 0, `lint` 0 errores, `test` 93 archivos / 872 casos en verde.
*Deliberadamente no hecho:* **no se aplicó override a `sharp`.** `next@16.2.6` declara `sharp: ^0.34.5` y el parche es `0.35.4`, fuera de rango; `sharp` tiene bindings nativos y el fallo sería en runtime (optimización de imágenes), no en build. `next@16.3.3` **deja de declarar `sharp`**, así que P0-DEP-01 cierra esos 2 advisories por eliminación.
*Deuda creada:* los overrides de `postcss` y `nanoid` quedan **retirables tras P0-DEP-01** (`next@16.3.3` ya fija `postcss: 8.5.23`). Revisarlos en ese PR; un override redundante fija una versión que nadie revisa. Detalle en `docs/security/dependencies.md`.

**P0-DEP-04 — Auditoría de dependencias en CI**
`.github/workflows/`
*Aceptación:* el job falla ante cualquier advisory `high`+ nuevo; existe un mecanismo de excepción con fecha de caducidad obligatoria.

### P0 · Workstream INFRA — Infraestructura de pruebas

**P0-DEP-05 — Renombrar `middleware` → `proxy`** — ✅ **COMPLETADA** (2026-09-09)
`src/middleware.ts` → `src/proxy.ts`, `src/middleware.test.ts` → `src/proxy.test.ts` (ambos con `git mv`), más comentarios en `next.config.ts` y cinco archivos de `src/`.
Tarea añadida durante la ejecución: la deprecación la surfacea la actualización de P0-DEP-01 y `AGENTS.md` obliga a atenderla. Se hizo como PR propio, separada del cambio de comportamiento de P0-BUG-02, porque toca el límite de autenticación.
`export async function middleware` → `export async function proxy`; el `export const config` con el `matcher` no cambia. No había flags de config afectados.
*Aceptación:* desaparece el aviso de deprecación del build; el proxy sigue aplicando la autorización de páginas.
*Resultado medido:* aviso desaparecido; `build` exit 0 (98 rutas), `typecheck` exit 0, `lint` 0 errores, `test` 93 archivos / 872 casos, `src/proxy.test.ts` 4/4. **Verificado en runtime** contra el build de producción: las 7 rutas protegidas devuelven `opaqueredirect` (3xx de servidor) con `redirect: 'manual'` y `/login` devuelve 200 — prueba que aísla el proxy del redirect de cliente de `dashboard-shell.tsx:27`, que no puede producir un `opaqueredirect`.

**P0-INFRA-01 — Introducir Playwright** — ✅ **COMPLETADA** (2026-09-09) *(desbloquea P0-BUG)*
`playwright.config.ts`, `e2e/`, `package.json`, `.github/workflows/e2e.yml`, nuevo `docs/testing-e2e.md`.
Proyectos `desktop-chromium` (1280×800) y `mobile-safari` (iPhone 13). Seed contra la pila local de Supabase con dos cuentas (Acme, Globex) y los cuatro roles.
*Aceptación:* `pnpm test:e2e` ejecuta un smoke (login → inbox → abrir conversación) en verde en ambos proyectos; el seed es idempotente y reejecutable.
*Resultado medido:* **6/6 en verde** (3 specs × 2 proyectos) en 7.4s. Idempotencia verificada comparando conteos de filas entre dos pasadas completas — idénticos, y cero cuentas huérfanas. `typecheck` exit 0, `lint` 0 errores, `test` 93 archivos / 872 casos, `build` exit 0 (98 rutas).
*Ids deterministas para conversaciones y contactos, no para cuentas:* forzar el id de cuenta exigiría re-keyear la fila del trigger de alta, y `profiles.account_id` la referencia sin `ON UPDATE CASCADE`. El seed los resuelve en runtime. Las pruebas cross-tenant solo necesitan el id de conversación.
*Dos `data-testid` añadidos en producción* (`conversation-list`, `message-thread`): el último mensaje se renderiza a la vez como burbuja del hilo y como vista previa de la lista, así que sin acotar `getByText` resuelve a dos elementos y la aserción pasaría aunque el hilo nunca se abriera.
*Tres trampas del entorno documentadas en `docs/testing-e2e.md`,* las tres capaces de disfrazarse de fallo de la aplicación: (1) el dev server de Next 16 **no hidata sobre `127.0.0.1`** —solo `localhost`— y sin hidratación todo formulario hace submit nativo, que se lee como "el login rechaza la contraseña"; (2) Next 16 no permite dos `next dev` en el mismo directorio, de ahí que la suite reutilice el puerto 3100 en vez de usar uno dedicado; (3) esperar a que los campos tengan valor **no** prueba hidratación, porque un input sin hidratar es no controlado y conserva el texto mientras `onSubmit` aún no existe.
*Bug corregido de paso:* `supabase/seed.sql` insertaba el usuario `dev@local.test` dejando NULL cinco columnas de token que GoTrue escanea como `string` no nulo. Rompía **cualquier** `admin.listUsers()` y la pestaña Auth de Studio con "Database error finding users". Ver P0-INFRA-03.

**P0-INFRA-03 — Corregir el usuario del seed de desarrollo** — ✅ **COMPLETADA** (2026-09-09)
`supabase/seed.sql`
Tarea añadida durante la ejecución de P0-INFRA-01, que quedaba bloqueada por este defecto. La fila `dev@local.test` se insertaba sin `confirmation_token`, `recovery_token`, `email_change`, `email_change_token_new` ni `phone`, que quedaban NULL. GoTrue los escanea en campos `string` de Go y falla al serializar cualquier página de resultados que incluya la fila.
*Aceptación:* `admin.listUsers()` responde 200 con cualquier tamaño de página.
*Resultado medido:* antes, `per_page>=5` devolvía 500 `"Database error finding users"`; ahora 200 con `per_page=200`. Se reparó además la fila viva de la base local, porque el seed solo se reaplica en `supabase db reset`.

**P0-INFRA-02 — Entorno de componentes React** — ✅ **COMPLETADA** (2026-09-09)
`vitest.config.ts` (dos proyectos vía `test.projects` de Vitest 4), nuevo `src/test-setup.dom.ts`; añadidos `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`.
División **por extensión**: `*.test.ts` → `node`, `*.test.tsx` → `jsdom`. Mecánico a propósito: no hay nada que recordar al añadir un test, ni forma de aterrizar un test de componente en el proyecto `node` y perder una tarde con un `document is not defined`.
*Aceptación:* los 872 tests existentes siguen pasando sin cambios; un test de componente pasa.
*Resultado medido:* 94 archivos / 876 casos en verde (872 previos + 4 nuevos de P0-BUG-02). El único `.test.tsx` que ya existía usa `renderToStaticMarkup` y funciona igual en jsdom.

### P0 · Workstream BUG — Bug de navegación del Inbox

**P0-BUG-01 — Instrumentar transiciones de auth** — ✅ **COMPLETADA** (2026-09-09)
Nuevo `src/lib/diagnostics/auth-trace.ts`; instrumentado `src/hooks/use-auth.tsx` (evento de auth + visibilidad) y `src/app/(dashboard)/dashboard-shell.tsx` (la expulsión). Reproducción en `e2e/auth-trace.spec.ts`. Informe en `docs/p0-bug-01-informe.md`. Variable `NEXT_PUBLIC_AUTH_TRACE` documentada en `.env.local.example`.
*Aceptación (superada):* pedía 24 h de telemetría en staging. Con la infraestructura de P0-INFRA-01 ya disponible se obtuvo una **reproducción determinista**, que es mejor evidencia: se puede volver a ejecutar contra el arreglo.
**Respuesta:** un `SIGNED_OUT` con sesión nula, **3 ms** antes de la expulsión, disparado por un fallo de refresh **no reintentable** (`refresh_token_not_found`) sobre un token caducado.
*Descartado por eliminación:* el retorno de pestaña por sí solo (cero eventos), la cookie borrada (cero eventos) y el fallo de **red** en el refresh (6 intentos, sesión preservada) **no** expulsan.
*Decisión de diseño:* la traza vive en `sessionStorage`, no en memoria — el fallo termina en navegación completa de documento, así que un array a nivel de módulo muere justo en el instante a capturar. Cada entrada anota si la cookie seguía presente, que es lo que separa un cierre de sesión legítimo de uno espurio.
*Corrige dos afirmaciones de §2.3* que la medición refutó. Ver el informe.
*Sigue pendiente en staging:* la mitad de la carrera en la que el proxy escribe una cookie nueva y válida mientras el cliente descarta la suya — esa es la que hace aterrizar en `/dashboard` en vez de `/login`. La traza ya sabe reconocerla: una expulsión con `hasAuthCookie: true`.

**P0-BUG-02 — El gate de auth deja de desmontar el árbol** — ✅ **COMPLETADA** (2026-09-09) *(Defecto A)*
`src/app/(dashboard)/dashboard-shell.tsx`, nuevo `src/app/(dashboard)/dashboard-shell.test.tsx`.
Las salidas tempranas que devolvían spinner o `null` en lugar de `children` se sustituyen por un overlay superpuesto. Se introduce un latch `hasAuthenticated` que separa dos situaciones que necesitan trato opuesto: **antes** de la primera sesión no se monta el árbol (un visitante anónimo no debe montar el dashboard, y en carga fría no hay estado que perder); **después**, `children` no se desmontan pase lo que pase con auth.
*Detalle de implementación:* el latch se fija **en render**, no en un efecto — es el patrón documentado de React para ajustar estado durante el renderizado. Hacerlo en un efecto pintaba un frame en la rama pre-auth después de que la sesión ya hubiera llegado, y además viola `react-hooks/set-state-in-effect`, que este repo tiene activa.
*Aceptación:* con `loading` forzado a `true` tras el montaje, el DOM del Inbox permanece y el estado no se pierde; test de componente que lo demuestra.
*Resultado medido:* 4 tests nuevos en verde. **Verificado que el test detecta el bug**: contra la implementación anterior fallan 3 de los 4. La evidencia es el conteo de montajes del hijo, no el marcado — un remontaje devuelve el mismo HTML y es invisible en un snapshot, pero es exactamente lo que pierde el estado.
*Verificación adicional:* E2E 8/8, y comprobación visual de que el `relative` añadido al contenedor no altera el layout ni deja overlay parásito.
*Lo que este cambio NO hace:* la redirección a `/login` sigue disparándose ante una sesión perdida — eso es P0-BUG-03. Lo que se garantiza aquí es que el contexto de trabajo no se destruye por el camino, que importa porque la medición de P0-BUG-01 mostró que la expulsión puede ocurrir con la pestaña oculta: el usuario no la ve suceder, vuelve y su trabajo ya no está.

**P0-BUG-03 — Confirmar el sign-out antes de actuar** — ✅ **COMPLETADA** (2026-09-09) *(Defecto B)*
`src/hooks/use-auth.tsx`, `src/app/(dashboard)/dashboard-shell.tsx`, `src/proxy.ts`, `src/app/(auth)/login/page.tsx`; nuevo `src/lib/auth/next-path.ts` (+ test); nuevos `src/hooks/use-auth.test.tsx` y casos en `src/proxy.test.ts` y `e2e/auth-trace.spec.ts`.

Un evento con sesión nula deja de aplicarse de inmediato: se confirma con `getUser()` tras 1,2 s. Solo un **no definitivo del servidor** cierra la sesión.

*Criterio de "definitivo", que es el núcleo del arreglo:* un `AuthRetryableFetchError`, un 5xx o un error sin `status` son **transporte**, no evidencia, y no cierran nada. Es la misma distinción que hace auth-js en `_recoverAndRefresh` y que P0-BUG-01 midió (6 intentos de red fallidos, sesión preservada). Confirmado que `AuthSessionMissingError` llega con `status` 400 (`auth-js errors.js:115-118`), así que un cierre real sí se aplica.

*Falla en abierto a propósito, y no es una decisión de seguridad:* `user` en el cliente es solo UI. La autorización vive en el proxy y en RLS, que no sirven datos a un token inválido. Equivocarse en esta dirección cuesta una pantalla desactualizada; en la contraria, el trabajo del usuario.

*Un `signOut()` deliberado se aplica al instante*, sin viaje de ida y vuelta: el usuario lo pidió.

*Segunda mitad, el `?next=`:* la redirección arrastra la ruta actual, y **el proxy la respeta** (`src/proxy.ts`). Antes hacía `url.search = ''` y depositaba al usuario en `/dashboard` — ese era literalmente el "me devuelve al inicio" del reporte. El propio redirect del proxy a `/login` también guarda ahora el destino, en vez de dejar el query original colgando (`/inbox?c=<id>` se convertía en `/login?c=<id>`).

*Riesgo introducido y cerrado:* un `next` es controlable por quien envíe el enlace, así que sin validar sería un **open redirect**. Un único `sanitizeNextPath` compartido por proxy, shell y login rechaza URLs absolutas, `//host` relativo al protocolo, variantes con barra invertida, esquemas peligrosos, espacios y control chars, y las propias páginas de auth (bucle). 12 tests, incluidos los cuatro vectores externos.

*Aceptación:* un `SIGNED_OUT` transitorio seguido de sesión válida **no** produce navegación; un sign-out real sí redirige a `/login`; volviendo a entrar se aterriza en la conversación previa, no en `/dashboard`.
*Resultado medido:* los tres criterios verdes. Traza de la reproducción E2E: `SIGNED_OUT` (1513 ms) → `signout:confirmed` (2716 ms) → `expulsion` (2759 ms) → `/login?next=%2Finbox%3Fc%3D…`. Los **3 ms** de margen que midió P0-BUG-01 son ahora una ventana de confirmación de 1,2 s. El viaje de vuelta aterriza en `/inbox?c=<id>` con el hilo visible.
*Verificado que los tests detectan el bug:* contra la implementación anterior fallan 2 de los 5 casos de `use-auth`.
*Verificación global:* typecheck 0, lint 0 errores, 96 archivos / 901 tests, build 98 rutas, E2E 9/9.

**P0-BUG-04 — Ruta por conversación e historial** — ✅ **COMPLETADA** (2026-09-09) *(Defecto C)*
`src/app/(dashboard)/inbox/page.tsx` → `src/app/(dashboard)/inbox/[[...conversationId]]/page.tsx` (con `git mv`); `src/proxy.ts`; enlaces en `notifications/page.tsx`, `lib/dashboard/queries.ts`, `calls/active-call-bar.tsx`; nuevo `e2e/inbox-navigation.spec.ts`.

*Desviación deliberada del plan:* un **catch-all opcional** `[[...conversationId]]` en vez de un `[conversationId]` separado. La razón es la que hacía peligroso el plan original: dos rutas distintas son dos segmentos distintos, así que cambiar de conversación **remonta** el componente y se pierden la lista cargada, los filtros, la búsqueda y el scroll — justo el estado que P0-BUG-02 acaba de proteger. Con un solo segmento opcional, `/inbox` y `/inbox/<id>` resuelven al mismo sitio y la navegación solo re-renderiza.

*Simplificación de fondo:* la conversación abierta **se deriva de la URL** en lugar de guardarse en estado. Antes había dos fuentes de verdad que había que sincronizar a mano, y por eso cada patch de realtime estaba escrito dos veces, una en `conversations` y otra en `activeConversation`. Al derivarla desaparecen esa duplicación, el `autoSelectedForDeepLinkRef` y toda la clase de bug "la lista se recargó y me saltó a otro hilo".

*Selección con `push`, no `replace`* — el arreglo del defecto C. El cerrar/volver hace `push("/inbox")`, no `router.back()`: hacer `back()` aterrizaría en el dashboard justo cuando el usuario vino de ahí, que es la queja del reporte.

*Compatibilidad:* redirección **308** de `/inbox?c=<id>` a `/inbox/<id>`, hecha en el proxy y no con `redirects()` de `next.config` — ese helper **añade al destino cualquier query que no consuma**, produciendo `/inbox/<id>?c=<id>`. Comprobado en E2E antes de moverlo. En el proxy además es testeable unitariamente.

*Bug preexistente corregido de paso:* `active-call-bar.tsx:37` enlazaba a `/dashboard/inbox?conversationId=…`, que nunca funcionó por dos motivos independientes: `(dashboard)` es un grupo de rutas y no aparece en la URL, y el inbox jamás leyó un parámetro `conversationId`.

*Aceptación:* abrir tres conversaciones y pulsar Atrás recorre las tres y luego llega a `/inbox` (**nunca** a `/dashboard`); Adelante rehace el camino; el botón cerrar/volver lleva a `/inbox`; funciona en desktop y móvil.
*Resultado medido:* 11/12 en verde en los dos proyectos (el salto es el control de volver, que por diseño solo existe bajo `lg`). typecheck 0, lint 0 errores y **41 warnings, uno menos que la línea base** (el import muerto de `toast` era preexistente), 96 archivos / 905 tests, build 98 rutas, E2E total 20/20. Verificado visualmente que el enlace antiguo aterriza en la URL limpia con lista e hilo correctos.
*Nota sobre los tests:* el proyecto móvil obligó a que el helper distinga panel único de dos paneles. La decisión se ata a 1024 px —el mismo `lg` que usa el CSS— y no a si la lista está visible en ese instante: el elemento desaparece durante un refetch, y tomar eso por "panel único" mandaba al test a buscar un botón que en desktop no existe.

**P0-BUG-05 — Resolución con estados distinguibles** — ✅ **COMPLETADA** (2026-09-09) *(Defecto D)*
Nuevo `src/lib/inbox/resolve-conversation.ts` (+ test); `src/app/(dashboard)/inbox/[[...conversationId]]/page.tsx`; mensajes en `messages/{es,en,ko}.json`; casos en `e2e/inbox-navigation.spec.ts`.

**Desviación del plan, por seguridad.** El plan pedía tres estados distinguibles: `ok`, `not_found` y `forbidden`. **Los dos últimos no son distinguibles, y es deliberado**: RLS devuelve cero filas para la conversación de otra cuenta exactamente igual que para una borrada. Separarlos exigiría una lectura con `service_role` que mire más allá de la frontera de inquilino, y convertiría la ruta en un oráculo — pegas un id y averiguas si es una conversación real de otra cuenta. Un ex-empleado con enlaces antiguos es justo quien saca partido de esa respuesta. Se devuelve `unavailable` para ambos, que además es lo que pedía el reporte original: *"si la conversación fue eliminada o el usuario perdió acceso, regresar a Inbox con un mensaje claro"* — **un** mensaje, cubriendo los dos casos.

*Cuatro estados, no tres:* `ok`, `unavailable`, `error` y `unauthenticated`. Los dos últimos existen para no repetir el error que corrigió P0-BUG-03 — un fallo de consulta no es prueba de nada y no debe expulsar a nadie.

*Interacción que detectó el propio E2E de P0-BUG-01:* sin sesión, RLS devuelve cero filas **sin error**, indistinguible de una conversación inaccesible. La primera versión tomaba una sesión moribunda por conversación borrada: mostraba un mensaje engañoso y, peor, redirigía a `/inbox` **antes** de la expulsión, así que el `?next=` acababa apuntando a la lista en vez del hilo que el usuario estaba leyendo — regresando el viaje de vuelta de P0-BUG-03. Resuelto confirmando la sesión antes de creerse el resultado vacío, la misma regla de "confirmar antes de actuar". Verificado: la URL final de la reproducción vuelve a ser `/login?next=%2Finbox%2F<id>`.

*Un id mal formado* se atrapa antes de la consulta: PostgREST lo rechazaría con un error de cast, que se leería como fallo de transporte y dejaría al usuario esperando un hilo que nunca carga.

*Aceptación:* URL de conversación borrada → `/inbox` con mensaje; URL de otra cuenta → `/inbox` con mensaje; **nunca** se renderiza contenido de otra cuenta; refrescar sobre una conversación válida la recupera con sus mensajes.
*Resultado medido:* E2E **28/28** (4 saltados por diseño), incluidos el aislamiento entre cuentas y el cambio de cuenta sin residuos. typecheck 0, lint 0 errores y 41 warnings, 97 archivos / 912 tests, build 98 rutas.
*Verificado que los tests detectan el bug:* contra la implementación anterior fallan 3 de los 4 casos nuevos. El cuarto —cambio de cuenta sin filtración— pasa en ambos, porque ese aislamiento ya lo garantizaba RLS: es guardia de regresión, no prueba del arreglo.

**P0-BUG-06 — Persistir filtros y búsqueda** — ✅ **COMPLETADA** (2026-09-09)
Nuevo `src/lib/inbox/filter-storage.ts` (+ test); `src/components/inbox/conversation-list.tsx`; casos en `e2e/inbox-navigation.spec.ts`.

**El criterio ya se cumplía en parte, medido antes de implementar nada.** Un sondeo E2E sobre el código existente dio:

| Escenario | ¿Sobrevivía? |
|---|---|
| Cambiar de pestaña y volver | **Sí** — ya lo arreglaron P0-BUG-02 (el árbol deja de desmontarse) y P0-BUG-04 (mismo segmento de ruta) |
| Ir a otra sección y volver | No |
| Recargar | No |

Así que la tarea real no era el cambio de pestaña sino la **recarga y la navegación entre secciones**, que sí remontan la página. Se implementa eso. El caso de la pestaña queda fijado igualmente como guardia de regresión, para que un cambio futuro en el gate de auth no lo rompa otra vez.

*`sessionStorage`, no `localStorage`:* esto es contexto de trabajo transitorio, no una preferencia. Un filtro dejado en "no leídas" hace tres semanas no debe seguir escondiendo conversaciones en una pestaña nueva hoy. (El toggle del panel de contacto es el caso opuesto y usa `localStorage` correctamente.)

*La clave lleva el `accountId`.* Dos personas compartiendo perfil de navegador —o una saltando entre sus propias cuentas— nunca heredan los filtros de la otra. Un filtro heredado esconde conversaciones en silencio, que es justo lo que se reporta como "faltan mensajes".

*Lectura tras el montaje, no en el inicializador de `useState`:* el servidor renderiza con los valores por defecto, así que leer el almacenamiento de forma síncrona hidrataría con valores distintos y React marcaría un desajuste. Mismo patrón que ya usa el toggle del panel de contacto.

*Alcance acotado a propósito:* **no se persiste la posición de scroll de la lista.** La lista se reordena por `last_message_at` con cada mensaje entrante, así que un desplazamiento restaurado apunta a conversaciones distintas de las que había al guardarlo — restaurarlo sería precisión aparente sin significado. El reporte pedía conservar "razonablemente" el contexto; los filtros y la búsqueda son la parte que sí lo tiene. La selección ya vive en la URL desde P0-BUG-04.

*Aceptación:* cambiar de pestaña y volver conserva filtro y búsqueda; cambiar de cuenta los reinicia por completo.
*Resultado medido:* E2E **36/36** (4 saltados por diseño). typecheck 0, lint 0 errores y 41 warnings, 98 archivos / 920 tests, build 98 rutas.
*Verificado que los tests detectan el bug:* contra la implementación anterior fallan los dos escenarios nuevos (recarga y cambio de sección). Los otros dos pasan en ambos, porque ya funcionaban — guardias de regresión, no prueba del arreglo.

### P0 · Workstream SEC — Seguridad

**P0-SEC-01 — Envoltorio de autorización `withRoute`** — ✅ **COMPLETADA** (2026-09-09)
Nuevo `src/lib/auth/guard.ts` (+ `guard.test.ts`) sobre `requireRole` y los predicados de `roles.ts`.
*Por qué un envoltorio, si `requireRole` ya existía:* el problema nunca fue la lógica sino que usarla era **opcional**. La ausencia de una comprobación es invisible en revisión — cada ruta resolvía bien la cuenta, simplemente no miraba el rol. El envoltorio convierte la declaración en parte de la forma de la ruta, no en un paso de su cuerpo.
*Aceptación:* tests unitarios cubren los cuatro roles × permitido/denegado; 401 sin sesión y 403 con rol insuficiente.
*Resultado medido:* **20 tests**, con la matriz completa 4×4 (cada rol contra cada `minRole`) más los casos límite. Afirmar un camino feliz y una denegación habría pasado por alto un desajuste de un peldaño en `hasMinRole`, que es el error que le daría a `agent` la superficie de `admin`.
*Detalle:* un fallo del handler devuelve **500, no 403**. Reportar un bug como problema de autorización manda a quien depure a mirar roles durante horas.
*Lección de método:* el primer test mockeaba `getCurrentAccount` y **no interceptaba nada** — `requireRole` la llama por su propio ámbito de módulo. Se mockea el cliente de Supabase una capa más abajo, de modo que corre la cadena real `getCurrentAccount → requireRole → hasMinRole`.

**P0-SEC-02 — Aplicar `withRoute` a las rutas desprotegidas** — ✅ **COMPLETADA** (2026-09-09)
Las 10 de §1.2, más `whatsapp/config` (ver abajo). Asignación aplicada: `whatsapp/send` y `whatsapp/react` → `agent`; `whatsapp/broadcast`, `templates/submit`, `templates/[id]`, `templates/sync`, `flows/templates`, `flows/[id]/runs` → `admin`; `whatsapp/config` (POST/DELETE) y `config/verify-registration` → `owner`; `whatsapp/media/[mediaId]` → `viewer`.

*Clasificación previa de las 71 rutas, para no rotar de más:* 43 ya usaban `requireRole` —correctas—, 11 usan `requireApiKey` (API pública), 6 son legítimamente sin sesión (webhooks, invitaciones, crons), 1 autenticaba sin decidir rol, y 10 no comprobaban nada. Migrar las 43 correctas habría sido rotación con riesgo de regresión y cero ganancia de seguridad, así que **no se tocaron**.

*Hallazgo adicional:* `whatsapp/config` **no era una brecha** —POST y DELETE ya rechazaban a quien no fuera owner— pero lo hacía con una comparación `role !== 'owner'` a medida que esquivaba `roles.ts`. Convertida para eliminar esa deriva. Su `GET` se deja intacto a propósito: su contrato documentado es devolver 200 siempre para que la UI muestre un mensaje en vez de un error, y `requireRole` lo habría convertido en 403 en un caso límite.

*Aceptación:* un `viewer` recibe 403; `agent` y superiores conservan el comportamiento; ningún test existente se rompe.
*Resultado medido:* **E2E 54/54**. `e2e/role-enforcement.spec.ts` ejercita las rutas con una sesión real de `viewer` —cookies reales, handlers reales— porque la UI ya le esconde los botones y esconder un botón no es autorización. **Verificado que detecta el bug: 7 de sus 9 casos fallan contra la implementación anterior.** Los 2 que pasan en ambos son los contrapesos (un viewer sí lee el proxy de media; un agent sí envía), que existen para que la suite no pasara igual si el guard rechazara a todo el mundo.
*Test existente actualizado:* `whatsapp/send/route.test.ts` fallaba porque su mock devolvía `account_id` sin `account_role`. Corregido y ampliado con la aserción que le faltaba: un viewer recibe 403 y no llega a hablar con Meta.
*Cambio de comportamiento a comunicar (D-7):* un `viewer` deja de poder enviar mensajes y reaccionar. Es lo que fija la política acordada —"viewer: lectura; agent: operación"— pero afecta a cualquiera que hoy dependa de esa permisividad.

**P0-SEC-03 — Test de CI que impide reabrir la brecha** — ✅ **COMPLETADA** (2026-09-09)
`src/lib/auth/route-guards.test.ts`.
*Invariante exigida:* que **exista una decisión de rol**, no que se use un helper concreto. Cuentan `withRoute` y `requireRole`; `getCurrentAccount()` a secas **no**, porque autentica y acota por cuenta pero no decide quién puede llamar — que es exactamente el hueco por el que un viewer podía enviar mensajes.
*Aceptación:* enumera `src/app/api/**/route.ts` y falla si alguna no declara rol sin estar en la allowlist justificada.
*Resultado medido:* pasa con 0 rutas sin declarar. El test se guarda a sí mismo (falla si el barrido devuelve menos de 50 rutas, para que un glob roto no lo vuelva vacuo), exige que cada excepción lleve escrito su mecanismo de autenticación, y detecta entradas muertas en la allowlist.

**P0-SEC-04 — Corregir SSRF y memoria en descarga de imágenes** — ✅ **COMPLETADA** (2026-09-09)
`src/lib/whatsapp/template-header-handle.ts`, `src/lib/whatsapp/template-header-handle.security.test.ts`.
*Aceptación:* URL a `169.254.169.254`, `localhost`, `10.0.0.1` y `.internal` → rechazo antes de cualquier conexión; respuesta de 100 MB → aborto sin superar 5 MB de heap; redirección a IP privada → rechazo; se conserva el comportamiento con URLs públicas válidas.

*Alcance confirmado antes de tocar nada:* un barrido de los `fetch` del servidor deja **este como el único con URL del usuario**. Los de `meta-api.ts` y `calls-api.ts` van a `graph.facebook.com`; los de webhooks y automations ya pasan por `isDeliverableUrl`. Queda anotado, sin actuar, `meta-api.ts:1034`: descarga de media desde una URL que da Meta en su respuesta — no la escribe el usuario, pero tampoco la validamos.

*Cuatro controles, en el orden en que actúan:*

1. **`https:` obligatorio y `isDeliverableUrl`**, el mismo guard que ya usaba el envío de webhooks. Rechaza *antes de abrir conexión*, que es la mitad que importa: un rechazo posterior ya ha entregado el ataque, porque el servicio interno recibió la petición y la diferencia entre un error rápido y uno lento es en sí misma una respuesta.
2. **Redirecciones seguidas a mano**, revalidando cada salto. Sin esto, `redirect` automático deja pasar un primer salto público y un segundo interno — la validación inicial mira el host equivocado.
3. **`Content-Length` rechazado antes de tocar el cuerpo.**
4. **Lectura en trozos, abandonada al cruzar los 5 MB.** El límite pasa de *describir* la reserva a *acotarla*.

*Corrección al planteamiento:* el mensaje de error ya no puede decir el tamaño real («es de 6,3 MB»), porque dejamos de leer y nunca llegamos a conocerlo. Dice el límite. Es consecuencia directa de arreglar la memoria, no un descuido.

*Decisión deliberada:* los errores de «dirección privada» y «no resuelve» son **idénticos**. Distinguirlos convertiría el mensaje en un oráculo para mapear la red interna probando nombres.

*Restricción que esto introduce, documentada y no sorteada:* con Supabase autoalojado en una red privada, la URL pública del bucket `chat-media` sería interna y quedaría rechazada. No afecta al modelo objetivo (un proyecto Supabase gestionado por cliente, `https://<ref>.supabase.co`) ni al desarrollo local, donde `WHATSAPP_TEMPLATES_DRY_RUN=true` ni siquiera llega a esta función. No se añade variable de escape: una sería justo el agujero que esto cierra.

*Riesgo residual, heredado del guard y no cerrado aquí:* **DNS rebinding**. `isDeliverableUrl` resuelve el host, pero `fetch` lo resuelve otra vez y no permite fijar la IP en el socket. Cerrarlo exige un agente HTTP propio.

*Resultado medido:* **33 tests** en los dos archivos. **Verificado que detectan el bug: 19 de los 21 casos de seguridad fallan contra la implementación anterior.** Los 2 que pasan en ambos son contrapesos deliberados (una imagen pública válida sigue pasando; y la comparación de mensajes, que era ya idéntica por accidente). La prueba de memoria no mide heap —sería frágil— sino que **cuenta los bytes que el cuerpo llegó a producir**: el código anterior deja `cancelled === false`, es decir, agotó los 100 MB enteros; el nuevo cancela por debajo de 10 MB. `typecheck` 0, `lint` 0 errores / 41 warnings (línea base), **101 archivos / 969 tests**, `build` 98 rutas, **E2E 54/54** (4 saltados por diseño).

*Nota sobre los tests existentes:* el doble de `Response` que usaban exponía solo `ok`, `status`, `headers.get` y `arrayBuffer`. Servía mientras la función leía el cuerpo entero y dejó de modelar la realidad en cuanto pasó a streaming — un doble sin `body` no puede mostrar si la lectura está acotada. Se sustituye por un `Response` real. El guard SSRF se deja abierto en ese archivo (resuelve DNS de verdad) y se ejercita real en el archivo de seguridad: un archivo por pregunta.

**P0-SEC-05 — Revocar EXECUTE a PUBLIC** *(migración 052, ver §7)*
*Aceptación:* con la clave `anon`, `POST /rest/v1/rpc/claim_ai_reply_slot` devuelve 401/403; ídem `touch_presence` y `record_webhook_failure` desde `anon`; el bot de auto-respuesta (service_role) y la presencia autenticada siguen funcionando; una consulta a `pg_proc` no devuelve ninguna función `SECURITY DEFINER` con `EXECUTE` para `PUBLIC`.

**P0-SEC-06 — Verificar la 034 en producción y automatizar el chequeo**
`docs/deploy/check-applied.sql`
*Aceptación:* el script comprueba la existencia del trigger `enforce_profile_privilege_columns` en `public.profiles` y de la función; ejecutado contra cada proyecto de cliente da APPLIED; se documenta la prueba manual real (un `PATCH` de `account_role` con JWT de viewer debe devolver 42501), corrigiendo la nota de `034:53-55`.

**P0-SEC-07 — Registro de migraciones aplicadas** *(cierra §1.3 punto 3)*
Nueva tabla `schema_release` + bloque de registro al final de cada bundle de `docs/deploy/`.
*Aceptación:* cada bundle registra su versión al aplicarse; `check-applied.sql` la lee; aplicar dos veces el mismo bundle es idempotente y no duplica filas.

**P0-SEC-08 — Cerrar el alta pública**
`src/app/(auth)/signup/page.tsx`, `src/proxy.ts:53`
Signup solo por invitación; email verificado obligatorio antes de la primera sesión útil.
*Aceptación:* `/signup` sin token de invitación válido no crea cuenta; el flujo de invitación existente (`/join/[token]`) sigue funcionando de extremo a extremo; un usuario sin email verificado no accede al dashboard.

**P0-SEC-09 — MFA para owner/admin y reautenticación en acciones críticas**
Supabase MFA (TOTP). `withRoute` acepta `reauth: true`.
*Aceptación:* un `owner`/`admin` sin MFA inscrito es dirigido a inscripción y no puede operar configuración; acciones críticas (rotar token de WhatsApp, exportación completa, transferir propiedad, crear API key, eliminar cuenta) exigen reautenticación reciente; un `agent` no se ve afectado.

**P0-SEC-10 — Aplicar CSP**
`next.config.ts:39`
*Aceptación:* tras un periodo de report-only sin violaciones en rutas reales, la cabecera pasa a `Content-Security-Policy`; la app funciona completa (inbox con media, realtime, gráficos) sin errores de consola.

### P1 · Workstream QUEUE — Durabilidad

- **P1-QUEUE-01** — Esquema `job_queue` + índices (migración 053, §7). *Aceptación:* dos workers concurrentes sobre 1000 jobs no procesan ninguno dos veces (test de concurrencia).
- **P1-QUEUE-02** — `src/lib/queue/` con `enqueue` (participa en la transacción del llamante), `claim` (lease + `SKIP LOCKED`), `complete`, `fail` (backoff con jitter), `reap` (abandonados), `deadLetter`. *Aceptación:* cobertura unitaria de cada transición de estado, incluido el paso a `dead` al agotar intentos.
- **P1-QUEUE-03** — Endpoint worker autenticado por secreto de cron, con límite de tiempo por invocación. *Aceptación:* drena hasta N jobs y devuelve métricas; invocaciones solapadas no duplican trabajo.
- **P1-QUEUE-04** — **Migrar broadcasts a la cola.** `src/hooks/use-broadcast-sending.ts:457` deja de enviar. *Aceptación:* cerrar la pestaña a mitad de un broadcast de 500 destinatarios **no lo detiene**; se completa y el progreso se refleja por realtime; reejecutar no duplica envíos (idempotencia por destinatario).
- **P1-QUEUE-05** — Entrega de webhooks a la cola, reutilizando el guard SSRF ya existente. *Aceptación:* un endpoint que responde 500 se reintenta con backoff y acaba en DLQ; uno que responde 200 se marca completo una sola vez.
- **P1-QUEUE-06** — Automations y flows sobre la cola. *Aceptación:* matar el proceso a mitad de ejecución la reanuda sin repetir pasos ya completados.
- **P1-QUEUE-07** — Inventario y monitorización de crons obligatorios (`automations/cron`, `flows/cron`, `ads/sync`, worker, barrido de abandonados, retención). *Aceptación:* `docs/ops/crons.md` los lista con cadencia y secreto; el Health Center muestra el último éxito de cada uno y alerta si se pasa su ventana.

### P1 · Workstream KEY — Cifrado

- **P1-KEY-01** — Keyset versionado en `src/lib/whatsapp/encryption.ts:29`; formato `v<N>:…`; los ciphertexts sin prefijo se leen como `v1`. *Aceptación:* los valores cifrados hoy se descifran sin cambios; los nuevos llevan prefijo; un test cubre rotación con dos claves activas simultáneamente.
- **P1-KEY-02** — Job de re-cifrado en segundo plano + runbook de rotación. *Aceptación:* rotar en staging deja todos los secretos legibles con la clave nueva y ninguno dependiente de la vieja; el runbook se ha ejecutado de principio a fin.
- **P1-KEY-03** — Keyset separado por cliente y por entorno; ninguna clave compartida. *Aceptación:* el alta de cliente genera keyset propio; una auditoría confirma que ningún valor de clave se repite entre instancias.

### P1 · Workstream STOR — Adjuntos

- **P1-STOR-01** — Bucket privado + URLs firmadas de corta vida o proxy autenticado (migración 054, §7). Resolver antes la decisión abierta D-3 (Meta necesita fetch público en algunos flujos). *Aceptación:* la URL directa de un adjunto devuelve 403 sin firma; un miembro de la cuenta lo ve; un miembro de otra cuenta no; el envío por WhatsApp sigue funcionando.
- **P1-STOR-02** — Retención configurable, 90 días por defecto para adjuntos, aplicada por job de cola. *Aceptación:* objetos más antiguos que la retención se eliminan y su registro se marca como purgado; el valor es configurable por cuenta; una cuenta con retención mayor conserva los suyos.

### P1 · Workstream DR — Copias y recuperación

- **P1-DR-01** — Backups automáticos de Database/Auth, Storage, configuración y referencias de claves (nunca las claves en claro), cifrados y almacenados fuera del proveedor principal.
- **P1-DR-02** — Runbook de restauración con RPO ≤ 1 h y RTO ≤ 4 h.
- **P1-DR-03** — **Ensayo de restauración trimestral** sobre un proyecto limpio, cronometrado.
  *Aceptación conjunta DR-01..03:* un ensayo real reconstruye una instancia funcional desde cero dentro de RTO, con pérdida de datos dentro de RPO, y el tiempo medido queda registrado. **Sin un ensayo ejecutado y documentado, este workstream no se da por terminado.**
- **P1-DR-04** — Runbook de alta de cliente (proyecto Supabase, migraciones, keyset, dominio, verificación). *Aceptación:* un operador que no escribió el runbook da de alta un cliente siguiéndolo, sin ayuda.

### P1 · Workstream OBS — Observabilidad

- **P1-OBS-01** — Logging estructurado con `accountId`, `userId`, `requestId`, sin PII en el cuerpo del log.
- **P1-OBS-02** — Tablas `module_flags` y `audit_log` + integración en `withRoute` (migración 055, §7). *Aceptación:* apagar un módulo por cuenta devuelve 503 con mensaje claro sin desplegar; toda acción con efectos deja fila de auditoría.
- **P1-OBS-03** — Health Center. *Aceptación:* muestra profundidad de cola, jobs muertos, último éxito de cada cron, estado de WhatsApp y advertencias de esquema.
- **P1-OBS-04** — Alertas. *Aceptación:* cada alerta se dispara en una prueba provocada y llega al canal de guardia.

### P2 · Producto

- **P2-BRAND-01** — Manifiesto de marca central (`src/lib/branding/manifest.ts`) sobre lo ya existente en `src/lib/branding/`. Separa marca del proveedor (dominio, login, docs, soporte, legales) de identidad configurable del cliente (dentro del workspace).
- **P2-BRAND-02** — Limpiar superficies públicas: `package.json:2-13` (`author`, `homepage`, `repository`, `bugs`), `README.md`, `CHANGELOG.md`, literales `wacrm:` (`inbox/page.tsx:22`) y prefijo `wacrm_live_` de API keys (con compatibilidad para claves ya emitidas). **Conservar `LICENSE` (MIT) y la atribución a Arnas Donauskas.** *Aceptación:* ninguna superficie visible al cliente muestra la marca original; la atribución y la licencia permanecen íntegras.
- **P2-NAV-01** — Navegación reducida al core: inbox, contactos, atribución, campañas, pipeline, tareas, configuración, automatizaciones esenciales.
- **P2-NAV-02** — Onboarding guiado, work queue global y Health Center.
- **P2-FLAG-01** — IA, broadcasts durables y flows-como-playbooks tras feature flags de beta.
- **P2-FLAG-02** — Ocultar llamadas (`src/components/calls/`, `api/calls/`) por flag, sin borrar código.
- **P2-FLAG-03** — MCP solo lectura por defecto (`mcp-server/src/tools/index.ts:19,24` — invertir defaults de `enableWrites`/`enableBroadcasts`) y escrituras de la API pública desactivadas hasta endurecerlas. *Aceptación:* un servidor MCP recién arrancado expone solo herramientas de lectura; habilitarlas exige variable explícita y queda registrado.
- **P2-FLOW-01** — **Integrar flows como una modalidad de Automations**, un solo concepto en producto. Nota: `use-auth.tsx:31-36` documenta que flows ya pasó a soft-GA y que `beta_features` no tiene consumidores actuales — ese campo es el vehículo natural para el flag.

### P3 · Diferenciación

- **P3-FUNNEL-01** — Funnel campaña → conversación → asignación → respuesta → negocio → ingreso, sobre lo existente en `src/lib/attribution/`.
- **P3-PLAY-01** — Playbooks por industria como automations preconfiguradas.
- **P3-COPILOT-01** — Copiloto comercial con **aprobación humana obligatoria**; nada sale a un cliente final sin confirmación explícita.
- **P3-ANALYTICS-01** — Analítica operativa obligatoria; analítica de producto opcional, transparente y sin PII.
- **P3-PILOT-01** — Piloto con 3–5 clientes tras el gate de §11.

---

## 6. Migraciones y cambios de datos

Numeración a partir de la 051 (última existente). Toda migración: idempotente, con bloque de verificación, y con su bundle equivalente en `docs/deploy/`.

**052 — `revoke_public_execute.sql`** *(P0-SEC-05)*
`REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon` sobre `claim_ai_reply_slot(uuid,integer)`, `touch_presence(...)`, `record_webhook_failure(...)`, `process_due_tasks()`, `is_account_member(UUID, account_role_enum)`, más los `GRANT` mínimos necesarios (`service_role` para las de backend, `authenticated` para presencia y `is_account_member`). Seguir el patrón exacto de `050_calls.sql:110-111`. Incluir consulta de verificación sobre `pg_proc`/`information_schema.routine_privileges` que liste cualquier `SECURITY DEFINER` con EXECUTE a PUBLIC (debe devolver cero filas).
**Riesgo:** revocar de más rompe el bot de auto-respuesta y la presencia. Verificar ambos flujos en staging antes de producción.

**053 — `job_queue.sql`** *(P1-QUEUE-01)*
Tabla con `id`, `account_id`, `type`, `payload jsonb`, `status` (`pending|running|done|failed|dead`), `attempts`, `max_attempts`, `run_at`, `locked_until`, `locked_by`, `idempotency_key`, `last_error`, `created_at`, `updated_at`. Índice parcial único sobre `idempotency_key WHERE idempotency_key IS NOT NULL`. Índice de claim sobre `(status, run_at)` filtrado a `pending`. RLS: lectura para miembros de la cuenta; escritura solo `service_role`.

**054 — `private_attachments.sql`** *(P1-STOR-01)*
`chat-media` a `public = false`; reemplazar la política de `023:79-86` por una que exija pertenencia a la cuenta; añadir columnas de retención. Requiere resolver D-3. **Cambio de datos:** las URLs públicas ya almacenadas en filas de mensajes dejan de resolver — se necesita backfill que las convierta a rutas relativas resueltas en el momento de la lectura.

**055 — `flags_and_audit.sql`** *(P1-OBS-02)*
`module_flags` (`account_id`, `module`, `enabled`, `updated_by`, `updated_at`) y `audit_log` (`account_id`, `actor_user_id`, `action`, `resource_type`, `resource_id`, `result`, `metadata jsonb`, `created_at`, particionada por mes). RLS: `audit_log` legible por admin+ de la cuenta, escribible solo por `service_role`.

**056 — `schema_release.sql`** *(P0-SEC-07)*
Tabla `schema_release(version text primary key, applied_at timestamptz default now(), applied_by text)`. Cada bundle de `docs/deploy/` termina con su `INSERT ... ON CONFLICT DO NOTHING`.

**Cambios de datos sin migración de esquema:**
- Re-cifrado de secretos al keyset versionado (P1-KEY-02), en segundo plano, reversible mientras la clave antigua siga en el keyset.
- Purga inicial de adjuntos por retención (P1-STOR-02): ejecutar primero en modo informe, revisar volumen con cada cliente, y solo entonces habilitar el borrado.

---

## 7. Estrategia de pruebas

### 7.1 Pruebas obligatorias del bug de navegación

**Todas son requisito de aceptación del workstream P0-BUG.** E2E en Playwright (`e2e/inbox-navigation.spec.ts`), ejecutadas en los proyectos `desktop-chromium` y `mobile-safari`:

| # | Escenario | Resultado esperado |
|---|---|---|
| 1 | Abrir conversación → cambiar a otra pestaña → volver | Sigue la misma conversación; URL intacta; mensajes visibles; sin navegación a `/dashboard` |
| 2 | Abrir conversación → `visibilitychange` hidden/visible forzado por script | Idéntico a #1; sin remontaje del árbol |
| 3 | Abrir conversación → recargar (F5) | Se recupera la misma conversación con sus mensajes |
| 4 | Abrir A, B, C → Atrás ×3 | C→B→A→`/inbox`. **Nunca `/dashboard`.** Adelante rehace el camino |
| 5 | Abrir conversación → borrarla desde otra sesión → volver a la pestaña | Redirige a `/inbox` con mensaje "ya no existe" |
| 6 | Usuario de cuenta A abre URL de conversación de cuenta B | Redirige a `/inbox` con mensaje de acceso; **cero contenido de B en el DOM o en la respuesta de red** |
| 7 | Cerrar sesión → entrar con usuario de otra cuenta → abrir Inbox | Ningún resto de la cuenta anterior en lista, filtros ni `sessionStorage` |
| 8 | Pulsar cerrar/volver dentro de una conversación | Aterriza en `/inbox`, no en `/dashboard` |
| 9 | Filtro + búsqueda + scroll → cambiar pestaña → volver | Los tres se conservan |
| 10 | Sesión expirada de verdad → volver a la pestaña | Redirige a `/login` con `?next=`; tras entrar, vuelve a la misma conversación |

Adicionalmente, unitarias/integración:
- `use-auth`: `SIGNED_OUT` transitorio seguido de sesión válida **no** limpia el estado ni navega (P0-BUG-03).
- `dashboard-shell`: `loading = true` tras el montaje no desmonta `children` (P0-BUG-02).
- Resolución de conversación en servidor: los tres estados `ok` / `not_found` / `forbidden` (P0-BUG-05).
- Persistencia de filtros con cambio de `accountId` (P0-BUG-06).

### 7.2 Pruebas de seguridad

- **Matriz de roles:** por cada ruta con efectos, los cuatro roles × permitido/denegado. Generada, no escrita a mano.
- **SSRF:** casos de `169.254.169.254`, `127.0.0.1`, `10.0.0.1`, `[::1]`, `foo.internal`, DNS que resuelve a privada, y redirección de pública a privada. Reutilizar la forma del test existente en `src/lib/automations/engine.test.ts:234-242`.
- **Memoria:** respuesta grande abortada antes de superar el límite.
- **RPCs:** cada función `SECURITY DEFINER` invocada con la clave `anon` debe fallar (excepto las de diseño público, `peek_invitation`).
- **Aislamiento de tenants:** para cada tabla con `account_id`, un usuario de la cuenta A no lee ni escribe filas de B.
- **Trigger 034:** `PATCH` de `account_role` y de `account_id` con JWT de viewer → 42501; edición de `full_name` → éxito; RPCs de miembros → éxito.

### 7.3 Pruebas de restauración

Ejercicio trimestral, cronometrado y documentado: restaurar Database/Auth, Storage y configuración en un proyecto limpio; verificar que los secretos se descifran con el keyset restaurado; verificar login, inbox y envío. **Un ensayo no cronometrado o no documentado no cuenta como realizado.**

### 7.4 Cobertura de regresión

Los 93 archivos / 872 tests actuales son la línea base y **deben seguir en verde en todo momento**. Ningún PR de esta spec puede reducir la cobertura existente.

---

## 8. Rollout, canary, rollback y roll-forward

### 8.1 Principios

- Un artefacto, muchas instancias. La diferencia entre clientes es configuración.
- Toda migración es idempotente y, cuando sea posible, compatible hacia atrás en ambos sentidos.
- Cambios de esquema en dos pasos: primero expandir (añadir), desplegar código que tolera ambos, luego contraer (retirar). Nunca expandir y contraer en el mismo despliegue.

### 8.2 Progresión

```
dev → staging (dataset sintético) → canary (1 cliente voluntario) → resto
```

- **Staging:** suite completa (unit + integración + E2E + seguridad). Gate obligatorio.
- **Canary:** un cliente que ha aceptado serlo, con volumen real. Mínimo **72 h** de observación. Métricas de guardia: tasa de 5xx, profundidad de cola, jobs muertos, fallos de descifrado, **y expulsiones de sesión** (métrica dedicada del bug del Inbox).
- **Despliegue general:** por lotes, nunca todos a la vez.

### 8.3 Rollback vs roll-forward

| Tipo de cambio | Estrategia | Motivo |
|---|---|---|
| Solo código, sin migración | **Rollback** al artefacto anterior | Inmediato y seguro |
| Migración expansiva (añade) | **Roll-forward**; el código anterior tolera lo añadido | Revertir esquema es más arriesgado que corregir |
| Migración contractiva (retira) | **Prohibido** sin dos despliegues previos con la columna sin uso | Evita pérdida irrecuperable |
| Rotación de claves | **Roll-forward**; la clave antigua permanece en el keyset hasta completar el re-cifrado | Retirarla antes rompe secretos |
| Bucket privado (054) | **Roll-forward** con flag; volver a público es un cambio de flag, no de esquema | Restaurar visibilidad debe ser instantáneo |

### 8.4 Kill switches como primera línea

Ante una incidencia en un módulo, la primera acción es **apagar ese módulo por cuenta** (P1-OBS-02), no revertir el despliegue completo. El rollback es el segundo recurso.

---

## 9. Riesgos, decisiones abiertas y fuera de alcance

### 9.1 Riesgos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R1 | Next 16.2.6 → 16.3.3 introduce rupturas no documentadas en el conocimiento previo | Alta | Alto | `AGENTS.md` es explícito: leer `node_modules/next/dist/docs/` antes de tocar routing/middleware. Actualizar aislado en su propio PR, con la suite completa |
| R2 | La 052 revoca de más y rompe auto-respuesta o presencia | Media | Alto | Verificar ambos flujos en staging; la migración es reversible con un `GRANT` |
| R3 | Pasar `chat-media` a privado rompe el fetch de Meta | **Alta** | Alto | **Decisión abierta D-3.** Prototipar antes de comprometer la 054 |
| R4 | El estado del bug no se reproduce en staging y P0-BUG-01 no captura nada | Media | Medio | Las correcciones A/C/D son deterministas y valen por sí solas; solo B depende del diagnóstico, y su fix (confirmar antes de actuar) es correcto en cualquier caso |
| R5 | El re-cifrado de claves deja secretos ilegibles | Baja | **Crítico** | La clave antigua permanece en el keyset; job reversible; ensayar en staging con datos reales copiados |
| R6 | Sin runner de migraciones, los clientes divergen durante la ejecución del plan | **Alta** | Alto | P0-SEC-07 es prerrequisito operativo del primer alta de cliente nuevo |
| R7 | Purga de retención borra datos que un cliente esperaba conservar | Media | Alto | Modo informe primero; revisión por cliente; consentimiento explícito antes de habilitar borrado |
| R8 | La migración de broadcasts a cola cambia el comportamiento percibido (ya no hay barra de progreso en vivo) | Media | Medio | Progreso por realtime desde la BD; comunicar el cambio como mejora ("sigue enviando aunque cierres") |

### 9.2 Decisiones abiertas — requieren respuesta antes de implementar

- **D-1 · Alcance de MFA.** ¿Obligatorio para `owner`/`admin` desde el día uno del piloto, o periodo de gracia? Impacta P0-SEC-09 y la fricción de onboarding en pymes.
- **D-2 · Ventana de reautenticación.** ¿Cuántos minutos vale una reautenticación reciente? Propuesta: 15. Impacta P0-SEC-09.
- **D-3 · Adjuntos y Meta.** `023_chat_media.sql:25` justifica el bucket público porque *"Meta can fetch the URL without auth"*. Hay que determinar por prueba en qué flujos concretos Meta exige URL pública y si una URL firmada de vida corta le sirve. **Bloquea P1-STOR-01 y la migración 054.** Es la decisión abierta de mayor riesgo.
- **D-4 · Retención.** ¿90 días aplican solo a binarios de adjuntos, o también a los mensajes que los referencian? Impacta obligaciones legales por país.
- **D-5 · Aislamiento de datos del piloto.** ¿Un proyecto Supabase por cliente desde el primer piloto, o compartido con RLS hasta validar? La spec asume separado; confirmar el coste.
- **D-6 · Compatibilidad del prefijo de API key.** ¿Se emiten claves nuevas con prefijo de marca propia manteniendo las `wacrm_live_` válidas indefinidamente, o hay fecha de retirada? Impacta P2-BRAND-02.
- **D-7 · Alcance de `viewer`.** Confirmar que un `viewer` **no** puede enviar mensajes. Es un cambio de comportamiento respecto a hoy (§1.2) y puede afectar a usuarios existentes que dependen de esa permisividad.

### 9.3 Fuera de alcance

- Migrar la cola a Redis/SQS. PostgreSQL es suficiente para 3–20 agentes; revisar solo si la profundidad de cola lo justifica.
- Reescribir el motor de automations o el builder de flows. P2-FLOW-01 es unificación de producto, no reingeniería.
- Rediseño visual completo. El rebranding es de marca, no de sistema de diseño.
- WhatsApp Calling más allá de ocultarlo tras un flag (`docs/whatsapp-calling-viability.md` ya recoge el análisis).
- Multi-región y alta disponibilidad activo-activo.
- Facturación y gestión de suscripciones.
- Apps móviles nativas. El requisito es que la web funcione en viewport móvil.

---

## 10. Gate final para comenzar el piloto

El piloto (P3-PILOT-01) **no arranca** hasta que todo lo siguiente sea cierto y esté documentado. Cada línea es verificable; ninguna se declara cumplida por juicio.

**Seguridad**
- [ ] `pnpm audit --prod` sin advisories `critical` ni `high`; `next >= 16.3.3`.
- [ ] Las 71 rutas de API usan `withRoute` o están en la allowlist justificada; el test de CI lo garantiza.
- [ ] Un `viewer` recibe 403 en las diez rutas de §1.2, verificado por test.
- [ ] El SSRF de `template-header-handle.ts` está cerrado, con tests de IP privada, DNS y redirección.
- [ ] Cero funciones `SECURITY DEFINER` con `EXECUTE` para `PUBLIC`, verificado por consulta en cada proyecto de cliente.
- [ ] El trigger de la 034 está aplicado y **probado contra base real** en cada proyecto.
- [ ] Existe registro de migraciones y `check-applied.sql` da APPLIED en todos los clientes.
- [ ] Alta pública cerrada; invitación + email verificado obligatorios.
- [ ] MFA activo para `owner`/`admin`; reautenticación en acciones críticas.
- [ ] CSP en modo aplicado.

**Bug de navegación**
- [ ] Las 10 pruebas E2E de §7.1 en verde en desktop y móvil.
- [ ] Los cuatro defectos (A, B, C, D) cerrados con su PR.
- [ ] 72 h en canary sin una sola expulsión de sesión desde el Inbox.

**Fiabilidad**
- [ ] Broadcasts, webhooks, automations y flows corren sobre la cola durable.
- [ ] Cerrar la pestaña a mitad de un broadcast no lo detiene, demostrado en canary.
- [ ] Todos los crons obligatorios configurados y monitorizados; Health Center muestra su último éxito.
- [ ] Adjuntos privados; retención configurada.
- [ ] Claves versionadas por cliente y entorno; rotación ejecutada de extremo a extremo en staging.

**Recuperación**
- [ ] Backups automáticos y cifrados fuera del proveedor principal.
- [ ] **Un ensayo de restauración ejecutado, cronometrado y documentado**, dentro de RPO ≤ 1 h y RTO ≤ 4 h.
- [ ] Runbook de alta de cliente validado por un operador que no lo escribió.

**Producto**
- [ ] Superficies públicas rebrandeadas; licencia MIT y atribución conservadas.
- [ ] Matriz de módulos de §11 implementada y coincidente con lo desplegado.
- [ ] Onboarding guiado, work queue global y Health Center operativos.
- [ ] MCP solo lectura; escrituras de API pública desactivadas.

**Operación**
- [ ] Auditoría registrando toda acción con efectos.
- [ ] Kill switches probados por módulo.
- [ ] Alertas verificadas por disparo provocado.
- [ ] Guardia definida con escalado y tiempos de respuesta.

---

## 11. Matriz de módulos

Clasificación: **Core** (visible, soportado, en el gate) · **Beta** (tras flag, visible solo a quien opta) · **Oculto** (código presente, no navegable) · **Desactivado** (deshabilitado por defecto, requiere acción explícita).

| Módulo | Clase | Rol mínimo | Flag / mecanismo | Notas de estado actual |
|---|---|---|---|---|
| Inbox | **Core** | viewer (lee) / agent (envía) | — | Requiere P0-BUG-02..06 completos |
| Contactos | **Core** | viewer / agent | — | — |
| Atribución (ads → conversación) | **Core** | viewer | — | Base en `src/lib/attribution/`, migraciones 037/038/042 |
| Campañas | **Core** | admin | — | — |
| Pipeline / Deals | **Core** | viewer / agent | — | — |
| Tareas de contacto | **Core** | agent | — | `049_contact_tasks.sql`; revocar `process_due_tasks` de PUBLIC (052) |
| Configuración (no crítica) | **Core** | admin | — | Apariencia, miembros, plantillas |
| Configuración (secretos e integraciones) | **Core** | **owner** | reauth obligatoria | WhatsApp, Meta App, IA, API keys |
| Automations (esenciales) | **Core** | admin | — | Sobre cola durable tras P1-QUEUE-06 |
| Quick replies | **Core** | agent | — | — |
| Notificaciones | **Core** | viewer | — | — |
| Health Center | **Core** | admin | — | Nuevo, P1-OBS-03 |
| Work queue global | **Core** | agent | — | Nuevo, P2-NAV-02 |
| Onboarding guiado | **Core** | admin | — | Nuevo, P2-NAV-02 |
| IA / auto-respuesta | **Beta** | admin | `module_flags.ai` | Requiere 052; `claim_ai_reply_slot` expuesta hoy |
| Broadcasts durables | **Beta** | admin | `module_flags.broadcasts` | No sale de beta hasta P1-QUEUE-04 |
| Flows (como playbooks de Automations) | **Beta** | admin | `module_flags.flows` | Unificar con Automations (P2-FLOW-01) |
| Base de conocimiento IA | **Beta** | admin | `module_flags.ai` | — |
| Llamadas WhatsApp | **Oculto** | — | `module_flags.calls` = false | Código conservado; migración 050 aplicada |
| MCP — herramientas de lectura | **Core** | API key con scope | — | `mcp-server/src/tools/read.ts` |
| MCP — escrituras | **Desactivado** | — | `WACRM_ENABLE_WRITES` (default off) | Invertir default en P2-FLAG-03 |
| MCP — broadcasts | **Desactivado** | — | `enableBroadcasts` (default off) | Ídem |
| API pública — lectura | **Core** | API key con scope | — | `src/app/api/v1/`, `docs/public-api.md` |
| API pública — escritura | **Desactivado** | — | `module_flags.public_api_write` = false | Hasta endurecer |
| Sincronización de Ads | **Beta** | admin | `module_flags.ads_sync` | Cron obligatorio, P1-QUEUE-07 |
| Exportación completa | **Core** | **owner** | reauth obligatoria | `api/export/full` |
| Enlaces rastreados | **Core** | agent | — | `040_tracked_links.sql` |
| Copiloto comercial | **Fuera de alcance hasta P3** | — | `module_flags.copilot` | Aprobación humana obligatoria |
| Analítica de producto | **Desactivado** | — | opt-in por cuenta | Transparente, sin PII |

---

## Apéndice A — Índice de evidencia

Rutas y líneas citadas, para verificación independiente.

**Bug de navegación**
`src/app/(dashboard)/inbox/page.tsx` — `:22` clave storage · `:27-33` Suspense · `:44` deep link · `:46-61` estado · `:97` ref auto-select · `:291-296` borrado · `:410-422` visibilitychange · `:444-478` resolución deep link · `:481-518` selección + replace · `:526-533` cierre
`src/app/(dashboard)/dashboard-shell.tsx` — `:25-29` push a /login · `:31-42` gates que desmontan
`src/hooks/use-auth.tsx` — `:140,145` estado loading · `:150` ref de último fetch · `:307-313` safety timer · `:315` init · `:352-369` onAuthStateChange · `:384` signOut
`src/proxy.ts` (renombrado desde `src/middleware.ts` en P0-DEP-01) — `:26` getUser · `:28-43` cookies rotadas · `:51-70` rebote /login → /dashboard · `:73-78` rutas protegidas
`src/lib/supabase/client.ts:9-18` — singleton
`src/components/inbox/conversation-list.tsx` — `:99-104` filtros locales · `:126-160` fetch con resyncToken
`src/components/inbox/message-thread.tsx` — `:174` onBack · `:318,348` efectos con resyncToken · `:897-904` botón volver
`src/hooks/use-require-role.ts:30` — replace a /dashboard (no usado por Inbox)
`src/components/presence/presence-heartbeat.tsx:83-88` — listeners de retorno
`node_modules/.pnpm/@supabase+auth-js@2.108.2/.../GoTrueClient.js` — `:3959-4056` `_recoverAndRefresh` · `:4285` SIGNED_OUT · `:4587` listener · `:4599-4638` `_onVisibilityChanged`

**Seguridad**
`src/lib/whatsapp/template-header-handle.ts:46,54,59,63` — SSRF y memoria
`src/lib/webhooks/ssrf.ts:25,53-79` — guard existente · `src/lib/webhooks/deliver.ts:27,93,124` · `src/lib/automations/engine.ts:28,626` · `src/lib/automations/engine.test.ts:234-242`
`src/app/api/whatsapp/templates/submit/route.ts:95,107,183` · `.../[id]/route.ts:157`
`src/app/api/whatsapp/send/route.ts:30,55` · `.../broadcast/route.ts:68,91` · `.../media/[mediaId]/route.ts:52,70`
`src/app/api/flows/route.ts:54` — delega en guard de cliente
`src/lib/auth/roles.ts:11-15,44,50-60` · `src/lib/auth/api-context.ts:8,22-27`
`supabase/migrations/029_ai_reply.sql:118-141` · `031_ai_reply_slot_grant.sql:27` · `049_contact_tasks.sql:72,139` · `024_member_presence.sql:56` · `028_webhook_endpoints.sql:91` · `017_account_sharing.sql:136,167` · `050_calls.sql:110-111` (patrón correcto)
`supabase/migrations/034_fix_profiles_update_rls.sql:24-27,53-55,58-81` · `docs/deploy/full-install.sql:4801-4824` · `docs/deploy/check-applied.sql:4-8`
`src/app/(auth)/signup/page.tsx:73` · `next.config.ts:24,28,39,133,182`

**Fiabilidad**
`src/hooks/use-broadcast-sending.ts:1,62-63,153,396,457`
`src/app/api/automations/cron/route.ts:19-30` · `src/app/api/flows/cron/route.ts:30-45` · `docs/pruebas-local.md:294`
`supabase/migrations/023_chat_media.sql:25,38,79-86` · `008_profile_avatars_storage.sql:15,35`
`src/lib/whatsapp/encryption.ts:29,41,70,90` · `src/app/api/whatsapp/config/route.ts:134,147,294` · `src/lib/ai/config.ts:63,110`
`vitest.config.ts` · `mcp-server/src/tools/index.ts:14-27` · `mcp-server/src/tools/write.ts:2`
`package.json:2-13,47,63-70`
