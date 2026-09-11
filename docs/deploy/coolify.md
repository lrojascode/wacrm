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

Cada fila debe decir `APPLIED`, y desde la migración 053 trae además una
columna `registro` que dice si alguien anotó ese bundle al aplicarlo.
Anota las que digan `MISSING` — esas son las que tienes que correr, y
solo esas.

> **`MISSING` + `registrado` es el peor caso y el que hay que mirar
> primero.** Significa que alguien dio ese bundle por aplicado y no lo
> está: casi siempre, el editor de Supabase cortó el script a la mitad.
> Vuelve a correrlo entero, por tramos si hace falta.
>
> **`APPLIED` + `sin registrar`** es normal en proyectos anteriores al
> registro y no requiere nada.

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

## 3.ter Activar el segundo factor — opcional

En **cada proyecto de cliente**: Authentication → Multi-Factor
Authentication → **TOTP (App Authenticator): ON**.

> **Hacen falta los dos interruptores, y no son lo mismo.** `enroll`
> permite añadir un autenticador; `verify` permite usarlo. Con solo el
> primero, alguien inscribe un factor y luego no puede superar el reto:
> queda encerrado por su propio segundo factor.

Esto **habilita** la función; no obliga a nadie. Cada persona decide si
la activa desde **Ajustes → Acceso y seguridad → Verificación en dos
pasos**, y puede desactivarla desde el mismo sitio.

### Qué cambia, exactamente

| Situación | Efecto |
|---|---|
| No lo ha activado | **Ninguno.** Entra con normalidad, sea owner, admin, agent o viewer. |
| Lo ha activado | Al iniciar sesión se le pide el código. Sin él, las rutas de configuración devuelven 403 — que es lo que hace que activarlo signifique algo. |

> **Por qué es opcional y no obligatorio por rol.** La primera versión
> lo exigía a todo `admin` y `owner`. Sobre el papel encajaba con la
> escala de roles; en la práctica, el día del despliegue dejó al owner
> del proyecto delante de un QR sin más salida que escanearlo. Una
> medida que se activa de golpe para todo el mundo no es una medida, es
> una puerta atascada.

### La reautenticación viene con ella

Cinco acciones —rotar o desconectar el WhatsApp, la exportación
completa, transferir la propiedad y crear una API key— piden el código
otra vez si la última autenticación tiene más de 5 minutos. **Solo a
quien tenga el segundo factor activado**: sin él no hay forma de
refrescar esa marca salvo cerrar sesión y volver a entrar, así que
exigirlo dejaría esas acciones inservibles.

Es la consecuencia honesta de que sea opcional: esa protección la tiene
quien lo activa. Conviene saberlo en vez de suponer que cubre a todos.

### Si alguien pierde el teléfono

No hay que tocar código ni desactivar nada. Se le retira el factor y
vuelve a entrar solo con su contraseña:

```sql
SELECT u.email, f.id, f.factor_type, f.status, f.created_at
FROM auth.mfa_factors f
JOIN auth.users u ON u.id = f.user_id
WHERE u.email = 'persona@cliente.com';

DELETE FROM auth.mfa_factors
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'persona@cliente.com');
```

Confírmalo con quien te lo pide por un canal distinto al correo: quien
puede pedir esto puede saltarse el segundo factor de esa cuenta.

---

## 3.quater La CSP pasa a bloquear — comprueba una variable

No hay nada que activar: la `Content-Security-Policy` deja de ser
`Report-Only` con este deploy (P0-SEC-10). Pero **depende de una
variable de entorno**, y conviene mirarla antes.

Los orígenes de Supabase permitidos ya no están escritos a mano: se
derivan de `NEXT_PUBLIC_SUPABASE_URL` cuando arranca el servidor. Eso
es lo que hace que la política sea correcta con Supabase gestionado,
autoalojado en dominio propio, o en local.

> **Si esa variable falta en el entorno de Coolify**, la política cae al
> comodín `https://*.supabase.co`. Con Supabase gestionado no se nota;
> con Supabase autoalojado en tu propio dominio, el navegador
> **bloqueará todas las llamadas a la base de datos** y la app se
> quedará sin datos, sin más pista que errores de CSP en la consola.
>
> La variable ya es obligatoria para que la app arranque, así que lo
> normal es que esté. Compruébalo igual: es un minuto.

### Comprobarlo tras el deploy

```bash
curl -sI https://tu-dominio.com/login | grep -i '^content-security-policy'
```

Debe aparecer `content-security-policy:` **sin** el sufijo
`-report-only`, y el `connect-src` debe nombrar **tu** host de Supabase.
Si dice `*.supabase.co` y tú no usas Supabase gestionado, falta la
variable.

Con la consola del navegador abierta, entra al inbox con una
conversación con media y mira el dashboard: cero errores de CSP. Eso es
lo que la suite comprueba en cada ejecución (`e2e/csp.spec.ts`), pero
una pasada a mano sobre el dominio real no sobra el primer día.

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
| **La verificación en dos pasos está disponible, y es opcional.** Se activa desde Ajustes → Acceso y seguridad. | Nadie, salvo que la active. Quien lo haga tendrá que introducir el código al entrar. Ver §3.ter. |
| **La CSP pasa a bloquear de verdad.** Antes solo informaba. | Nadie, si `NEXT_PUBLIC_SUPABASE_URL` está bien: la suite recorre login, inbox con media y realtime, dashboard con gráficos y ajustes contra un build de producción y exige cero violaciones. Ver §3.quater. |

---

## 6. Si algo falla

- **«permission denied for function ...» después de la 052.** Una función
  legítima se quedó sin su concesión. No reabras `PUBLIC`: concédesela
  nominalmente al rol que la llama (`service_role` para el backend,
  `authenticated` para el navegador) y anótalo en la migración.
- **`check-applied.sql` da `MISSING` en algo que juras haber corrido.** Lee la
  fila: dice qué objeto busca. Suele ser que el editor cortó el script a la
  mitad por el separador de sentencias.
