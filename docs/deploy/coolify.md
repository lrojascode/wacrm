# Deploy en Coolify — qué SQL correr en Supabase, y en qué orden

Este archivo existe porque en este montaje **no hay migration runner**: los
bundles de `docs/deploy/` se pegan a mano en el editor SQL de Supabase, y nada
registra que corrieron. La única respuesta honesta a *"¿qué me falta?"* la da
`check-applied.sql`, y la única respuesta honesta a *"¿y funciona?"* la da
probarlo.

> **El orden importa, y este es el seguro: primero el SQL, después el
> redeploy.** Todos los cambios de esquema de esta tanda son aditivos, así que
> el código que ya está corriendo en producción sigue funcionando contra el
> esquema nuevo. Al revés apuntarías código nuevo a objetos que todavía no
> existen.

---

## 0. Antes de nada: saber dónde estás

En el editor SQL de cada proyecto de cliente:

```sql
-- pega docs/deploy/check-applied.sql
```

Cada fila debe decir `APPLIED`. Anota las que digan `MISSING` — esas son las
que tienes que correr, y solo esas.

**Excepción conocida:** `047 owner-only settings` sale `MISSING` en local tras
un `supabase db reset` aunque la migración corriera. Es un artefacto del stack
local, no de producción; está explicado en [README.md](README.md#nota-sobre-supabase-db-reset-y-la-migración-047).

---

## 1. Proyecto nuevo (cliente que empieza)

Un solo archivo, una sola vez:

```
docs/deploy/full-install.sql          -- migraciones 001 → 052
```

Pesa ~300 KB. Si el editor se atraganta o reporta un error de sintaxis que no
tiene sentido, no es el SQL: es su separador de sentencias del lado del
cliente. Cada migración empieza con un banner `-- ####`; se puede correr por
tramos copiando de banner a banner.

Después salta al **paso 3 (verificación)**. No hace falta nada más.

---

## 2. Proyecto existente — los dos parches de seguridad de esta tanda

Estos dos **no son mejoras, son parches**. Hasta aplicarlos, ese proyecto está
expuesto. Córrelos antes que cualquier otra cosa pendiente.

### 2.1 `revoke-public-execute.sql` — obligatorio (052)

```
docs/deploy/revoke-public-execute.sql
```

**Qué arregla.** Postgres concede `EXECUTE` a `PUBLIC` en toda función nueva
sin que nadie lo escriba, y una función `SECURITY DEFINER` se salta RLS por
definición. Once funciones de este esquema quedaban invocables con la clave
`anon` — la que viaja dentro del bundle del navegador y es pública por diseño.

Medido, sin sesión alguna:

```
POST /rest/v1/rpc/record_webhook_failure {"endpoint_id":"<uuid>","max_failures":1}
→ HTTP 204   ·   ese endpoint pasa de is_active=true a false
```

Cualquiera desactivaba el webhook de cualquier inquilino con una petición.

### 2.2 `profile-privilege-columns.sql` — solo si la fila 034 dice MISSING

```
docs/deploy/profile-privilege-columns.sql
```

**Qué arregla.** Sin este trigger, cualquier usuario con sesión se asciende a
`owner` —o se muda al inquilino de otro— con un PATCH desde la consola del
navegador. Ambos se cuelan por la política RLS porque `user_id` no cambia: RLS
acota **qué filas** puedes escribir, no **qué columnas**.

Hasta ahora la 034 solo viajaba dentro de `full-install.sql`, así que un
proyecto migrado bundle a bundle podía no tenerla sin que nada lo dijera.

### 2.3 El resto de bundles pendientes

Los que `check-applied.sql` marque como `MISSING`, en orden numérico. Cada uno
es idempotente.

> **No corras `full-install.sql` sobre una base en producción** para "ponerla
> al día". No destruye datos, pero reejecuta 52 migraciones enteras —incluido
> rehacer políticas y restricciones— cuando lo que necesitas son las dos que
> faltan.

---

## 3. Verificación — `APPLIED` no es lo mismo que "funciona"

Las filas de `check-applied.sql` preguntan al catálogo si un objeto existe.
Para las dos de seguridad eso es necesario y **no suficiente**: un trigger
puede estar presente y no parar el ataque. Estas dos comprobaciones se hacen
una vez por proyecto, a mano.

### 3.1 Ninguna función `SECURITY DEFINER` sigue abierta

```sql
SELECT p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND has_function_privilege('public', p.oid, 'EXECUTE');
```

**Cero filas.** Si devuelve una función que el bundle no menciona, ese proyecto
tiene una que nosotros no conocemos: revócala y concede solo el rol que la
llama de verdad.

### 3.2 La escalada de privilegio está cerrada

Con un usuario **no-owner** real de ese proyecto con sesión abierta, coge su
access token del navegador (Application → Cookies, el valor `sb-<ref>-auth-token`):

```bash
curl -i -X PATCH \
  "https://<ref>.supabase.co/rest/v1/profiles?user_id=eq.<su-uuid>" \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <SU_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"account_role":"owner"}'
```

Debe devolver **403 con código 42501**. Y el camino legítimo debe seguir
abierto:

```bash
  ... -d '{"full_name":"El Mismo Nombre"}'     # → 204
```

Si el primero devuelve 204, ese proyecto está expuesto: cualquiera con sesión
se hace owner. Para antes de desplegar.

---

## 3.bis Cerrar el alta pública — ajuste de proyecto, no SQL

**Esto no se arregla con SQL ni con un deploy.** `signUp()` va del
navegador a Supabase directamente, y la clave `anon` viaja dentro del
bundle de JavaScript: cualquier gate en la app es decorativo. Medido
antes del cambio, un solo POST anónimo a `/auth/v1/signup` devolvía un
access token **y** dejaba a quien llamara como `owner` de un inquilino
nuevo.

En **cada proyecto de cliente**: Authentication → Sign In / Providers →
**"Allow new users to sign up": OFF**.

> ### ⚠️ El error que cuesta una tarde
>
> Hay **dos** interruptores parecidos y solo uno es el correcto.
>
> | Ajuste | Qué hace |
> |---|---|
> | **Allow new users to sign up** (general) | ✅ El que buscas. Bloquea `POST /signup` con `422 signup_disabled` y **nada más**. |
> | **Email provider → enabled** | ❌ **No lo toques.** Apagarlo no desactiva "el alta por correo": desactiva el proveedor entero, y **quien ya tiene cuenta deja de poder iniciar sesión** (`Email logins are disabled`). |
>
> Lo descubrí apagando el segundo: el bloqueo del alta funcionaba
> perfectamente y el login de un usuario existente devolvía
> `email_provider_disabled`. Desde fuera parece que el deploy rompió el
> acceso de todo el mundo.

**Las dos vías legítimas siguen funcionando**, porque los endpoints de
administración de GoTrue están exentos de este interruptor:

- `POST /api/invitations/<token>/claim` — el invitado crea su cuenta
  desde el enlace (nuevo en esta tanda).
- `POST /api/account/members` — el owner añade a alguien a mano.

### Comprobarlo

```bash
curl -i -X POST "https://<ref>.supabase.co/auth/v1/signup" \
  -H "apikey: <ANON_KEY>" -H "Content-Type: application/json" \
  -d '{"email":"prueba-alta@ejemplo.test","password":"unaClaveLarga123"}'
```

Debe devolver **422** con `"error_code":"signup_disabled"`. Si devuelve
200, ese proyecto sigue aceptando registros de cualquiera.

Y confirma que **no** rompiste el login, que es la otra mitad:

```bash
curl -i -X POST "https://<ref>.supabase.co/auth/v1/token?grant_type=password" \
  -H "apikey: <ANON_KEY>" -H "Content-Type: application/json" \
  -d '{"email":"<un usuario real>","password":"<su contraseña>"}'
```

Debe devolver **200** con un `access_token`.

---

## 3.ter Activar el segundo factor — ajuste de proyecto, no SQL

En **cada proyecto de cliente**: Authentication → Multi-Factor
Authentication → **TOTP (App Authenticator): ON**.

> **Hacen falta los dos interruptores, y no son lo mismo.** `enroll`
> permite añadir un autenticador; `verify` permite usarlo. Con solo el
> primero, alguien inscribe un factor y luego no puede superar el reto:
> queda encerrado por su propio segundo factor.

### Qué cambia, exactamente

| Rol | Efecto |
|---|---|
| `viewer`, `agent` | **Ninguno.** Ni se les pide ni se les redirige. |
| `admin`, `owner` | Al entrar se les lleva a `/mfa` a inscribir el autenticador. Sin él, las rutas de **configuración** devuelven 403; el inbox y el trabajo diario siguen funcionando. |

La exigencia se deriva del rol mínimo que cada ruta ya declara, así que
cubre por igual las rutas nuevas y las viejas.

Además, cinco acciones piden **volver a teclear el código** aunque la
sesión ya sea de confianza, si la última autenticación tiene más de
5 minutos: rotar o desconectar el WhatsApp del inquilino, la
exportación completa, transferir la propiedad y crear una API key.

### ⚠️ Antes de desplegar: avisa a quien administra

El día del deploy, cada `owner` y cada `admin` necesita una app de
autenticación a mano (Google Authenticator, 1Password, Authy…). No
quedan bloqueados —se les lleva a la pantalla de inscripción, con QR y
clave manual—, pero es una sorpresa evitable.

### Si alguien pierde el teléfono

No hay que tocar código ni desactivar nada. Se le retira el factor y en
su siguiente entrada vuelve a inscribirlo:

```sql
-- Mira qué tiene inscrito
SELECT u.email, f.id, f.factor_type, f.status, f.created_at
FROM auth.mfa_factors f
JOIN auth.users u ON u.id = f.user_id
WHERE u.email = 'persona@cliente.com';

-- Retíralo: vuelve al estado "sin inscribir", no a "sin acceso"
DELETE FROM auth.mfa_factors
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'persona@cliente.com');
```

Confírmalo con quien te lo pide por un canal distinto al correo: quien
puede pedir esto puede saltarse el segundo factor de esa cuenta.

---

## 4. Redeploy en Coolify

Solo cuando el paso 3 esté limpio:

1. Merge a `main`.
2. Redeploy en Coolify.

**No hacen falta variables de entorno nuevas** para esta tanda.
`NEXT_PUBLIC_AUTH_TRACE` sigue siendo opcional y solo para staging.

---

## 5. Cambios de comportamiento que conviene avisar antes

No son bugs; son las decisiones de esta tanda. Si alguien depende de lo de
antes, se va a notar el mismo día del deploy.

| Cambio | A quién afecta |
|---|---|
| **Un `viewer` ya no puede enviar mensajes ni reaccionar.** Es lo que fija la política de roles (*viewer: lectura; agent: operación*), pero antes la comprobación simplemente no existía en diez rutas. | Cualquier cuenta donde alguien con rol `viewer` esté operando de hecho. Conviene revisar los roles reales antes del deploy. |
| **La imagen de cabecera de una plantilla debe ser `https://` y pública.** Direcciones privadas, `localhost` e internas se rechazan, y la descarga se corta a 5 MB. | Un montaje con Supabase autoalojado en red privada: la URL del bucket sería interna y quedaría rechazada. No afecta a Supabase gestionado. |
| **Las URLs del inbox llevan ahora el id de conversación** (`/inbox/<id>`). Los enlaces antiguos `?c=<id>` siguen funcionando con un 308. | Nadie, pero explica por qué la 052 importa más que antes: ese id ahora viaja en enlaces y capturas. |
| **`/signup` ya no registra a nadie sin invitación.** La página lo dice en lugar de mostrar un formulario que fallaría al enviar, y `/login` deja de ofrecer "Crear cuenta" cuando no hay invitación de por medio. | Cualquiera que enviara el enlace de `/signup` a un compañero: ahora hay que mandarle una invitación desde Configuración → Miembros. |
| **Quien no tenga el correo verificado no entra al dashboard.** | Nadie hoy: con `enable_confirmations = false` GoTrue autoconfirma, así que toda cuenta existente ya lo tiene. Comprobado contra la base antes de añadir el control. Importa el día que actives las confirmaciones. |
| **`owner` y `admin` necesitan un autenticador TOTP para tocar la configuración**, y cinco acciones críticas piden el código otra vez si han pasado más de 5 minutos. | Todo el que administre una cuenta, el mismo día del deploy. Ver §3.ter: avísales antes, y ten a mano el SQL de recuperación. **`agent` y `viewer` no se ven afectados.** |

---

## 6. Si algo falla

- **«permission denied for function ...» después de la 052.** Una función
  legítima se quedó sin su concesión. No reabras `PUBLIC`: concédesela
  nominalmente al rol que la llama (`service_role` para el backend,
  `authenticated` para el navegador) y anótalo en la migración.
- **`check-applied.sql` da `MISSING` en algo que juras haber corrido.** Lee la
  fila: dice qué objeto busca. Suele ser que el editor cortó el script a la
  mitad por el separador de sentencias.
