# Lectura compartida y compositor del Inbox

Implementación del 2026-10-21. La investigación anterior está en
`docs/inbox-unread-investigation.md`; sus observaciones corresponden al código
anterior al arreglo, no al estado actual. La evidencia de las cuatro regresiones
antes del arreglo está en `evidence/inbox-before.txt`.

## Contrato

- `unread_count` continúa siendo compartido por conversación, nunca por agente.
- `messages.inbox_unread` identifica pendientes concretos. No es el estado
  `messages.status='read'` de WhatsApp ni envía confirmaciones de lectura a Meta.
- Un agente, administrador o propietario reconoce los IDs cargados y presentes
  en el DOM al llegar al final (tolerancia 2 px), después del pintado y con el
  documento visible. Una ventana modal o el overlay de sesión posponen el reconocimiento.
  El umbral de 64 px del seguimiento automático de scroll no reconoce por sí solo.
- `viewer` consulta sin modificar el contador. Enviar, especialmente desde un
  bot, no reconoce mensajes. Llegadas concurrentes o con fechas antiguas quedan
  pendientes si su ID no formaba parte del lote observado.
- Una carga inicial incompleta o fallida no reconoce. Una caché previamente
  cargada puede reconocer sus IDs conocidos mientras se revalida; no reconoce
  mensajes omitidos. El historial se pagina por `(created_at, id)`, a 500 filas.
- Solo entrantes contables y llamadas perdidas aumentan el contador. INSERT,
  reconocimiento y agregado son transaccionales. Lotes repetidos no producen
  escrituras adicionales. Reentregas del mismo ID de Meta dentro de una
  conversación no vuelven a insertar ni disparar automatizaciones.
- La cola guarda únicamente IDs en sessionStorage, por usuario/cuenta. Sobrevive
  a navegar fuera del Inbox y a recargar. Agrupa durante 250 ms, limita a 500 IDs
  y una solicitud por conversación, con timeout de 10 s y cinco reintentos
  (1/2/4/8/16 s). Después espera recuperación; oculta/offline no hace intentos.
  Visibilidad, online, pageshow, foco y reconexión se agrupan. Un error de permisos o
  argumentos es terminal. Si el almacenamiento está restringido, queda la cola
  en memoria y se pierde su persistencia al recargar.
- `unread_revision` ordena agregados de RPC, consultas y Realtime. Lista e
  indicador general se resincronizan sin sumar mensajes por su cuenta.

La posición final se conserva también cuando banners, compositor o viewport
cambian de tamaño después del primer scroll; revisar historial antiguo conserva
su ancla. Realtime se considera preparado cuando confirma PostgreSQL con
`system/ok`, no al simple `SUBSCRIBED`; los canales degradados se reemplazan con
espera creciente y un máximo de cinco reintentos. Ver el
[protocolo de Supabase](https://supabase.com/docs/guides/realtime/protocol).

La prueba de 1.001 mensajes alcanzó el límite local de 100 eventos/s y evidenció
pérdidas silenciosas. Una reconciliación compacta compartida cada **15 segundos**,
solo visible y online, recupera contadores/vistas previas aunque el socket no
avise. Se retrasa 250 ms la comprobación de huecos del hilo para dar tiempo al
INSERT; únicamente se vuelve a consultar el historial si siguen faltando
entrantes conocidos por el agregado. No se elevaron límites para ocultar el fallo.
Los lotes grandes generan eventos de lectura por mensaje: vigilar cuotas y
latencia de Realtime en el despliegue; la recuperación no sustituye dimensionarlo.

## Entorno y comandos

Nunca se utiliza producción para estas pruebas. Seed y helpers rechazan destinos
remotos incluso con `E2E_ALLOW_REMOTE=1`. `E2E_DB_URL`, si se usa, también debe ser local.
Node 24 es la versión de CI. Supabase CLI: 2.117.0.

```sh
pnpm run supabase:start:inbox:test
pnpm exec playwright install chromium webkit
pnpm test
pnpm run lint
pnpm run typecheck
E2E_PROD=1 E2E_PROVIDER_MOCKS=1 pnpm exec playwright test
```

El perfil `supabase:start:inbox:test` incluye Storage, Auth, REST, Realtime y
PostgreSQL. Si la pila reducida estaba levantada, usar `supabase stop` sin
`--no-backup` antes de iniciar ese perfil. Las credenciales de `.env.local`
deben corresponder a esa pila local. Un reset se realiza **solo** en la base local
E2E descartable (`supabase db reset --local`), nunca en una base compartida.

`E2E_PROVIDER_MOCKS=1` precarga un transporte exclusivamente en el proceso E2E.
Las rutas reales de Next, autenticación, persistencia y Storage se ejecutan;
se sustituyen solamente las solicitudes externas a Meta e IA. Las demás salidas
externas se bloquean. No demuestra entrega real en WhatsApp ni calidad de IA.
No configurar esta variable en el despliegue. Se deshabilita el indicador de
desarrollo de Next solo en este modo para que no tape el botón móvil «+».
El runner no reutiliza un servidor sin ese transporte; detener un dev server que
ocupe 3100 antes de la pasada, o usar otro puerto sin un segundo `next dev` en el mismo directorio.

Pruebas focalizadas:

```sh
pnpm exec vitest run src/components/inbox/unread-investigation.test.tsx src/lib/inbox/read-queue.test.tsx src/lib/inbox/unread.test.ts src/hooks/use-presented-inbox-messages.test.tsx
E2E_PROVIDER_MOCKS=1 pnpm exec playwright test e2e/inbox-unread-db.spec.ts e2e/inbox-unread.spec.ts e2e/inbox-mobile.spec.ts
pnpm test:e2e:report
```

Las cuatro antiguas `it.fails` son regresiones normales. El control de salientes
ahora exige cero antes y después del UPDATE, sin exigir el indicador falso anterior.
La reproducción SQL usa dos conexiones y una barrera de lectura real; reproduce
la operación antigua de read-modify-write sobre PostgreSQL. No se presenta como
una reproducción extremo a extremo de la entrega de Meta anterior al arreglo.

## Evidencia automatizada

Resultado de la ejecución final, métricas y capturas conservadas:
[evidence/inbox-2026-10-21/README.md](evidence/inbox-2026-10-21/README.md).

Los specs nuevos verifican separadamente estado persistido y DOM, dos sesiones
con el mismo agente y con agentes distintos, lista/URL, historial retenido,
segundo plano, scroll antiguo, recarga, fallo de reconocimiento/offline,
automáticos, respuesta humana concurrente, >1.000 mensajes, permisos y llamadas.
La suite de base también verifica backfill, reejecución, exclusión de otros
inquilinos y fusiones. Las pruebas de cola cubren tiempos, idempotencia y un
transporte que no responde al aborto.

El panel de contacto y su control se muestran desde 1280 px (`xl`). A 1024 px
los tres paneles dejaban solo 34 px para escribir; se conserva lista + hilo en
ese rango y se exige un campo de al menos 160 px en todos los tamaños. Los
accesos dedicados y la ayuda del compositor de escritorio se conservan.

La geometría se mide a 320, 360, 390, 414, 639, 640, 1023, 1024 y 1280 px,
incluyendo 390×400 y 844×390. Se comparan rectángulos reales, desbordamiento,
separación de indicadores, botones 44×44 y altura de menú tras su animación.
Se ejercitan IA, texto, respuestas rápidas, interactivos, plantillas expiradas,
selector de archivos, carga a Storage, cancelación y envío de documento.
El informe HTML adjunta las mediciones JSON, estados persistidos y capturas de
320 y 1280 px aun en verde; los fallos conservan trace, vídeo y captura.

`desktop-chromium` y `mobile-safari` son Chromium/WebKit automatizados.
**WebKit con perfil iPhone no es un iPhone físico.** Reducir la altura tampoco
reproduce el teclado, el selector nativo ni la suspensión del sistema operativo.

## Despliegue y verificaciones pendientes

Aplicar únicamente el bundle incremental `docs/deploy/inbox-read-state.sql`
antes de desplegar el código; ver también `docs/deploy/coolify.md`.
La migración obtiene ambos bloqueos de tabla sin esperar; si hay actividad que
los impida, aborta sin cambios para reintentar en la ventana acordada. Durante
el backfill bloquea lecturas y escrituras; los demás bloqueos tienen límite de 10 s. Medir volumen y duración, preparar respaldo y acordar ventana
antes del corte. No usar `full-install.sql` para actualizar producción.

Preflight anterior a la migración, solo lectura:

```sql
SELECT c.id, c.unread_count, count(m.id) FILTER (
  WHERE m.sender_type='customer' AND (m.content_type<>'call' OR m.call_outcome='missed')
) AS eligible
FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id
GROUP BY c.id
HAVING coalesce(c.unread_count,0)<0 OR coalesce(c.unread_count,0)>count(m.id) FILTER (
  WHERE m.sender_type='customer' AND (m.content_type<>'call' OR m.call_outcome='missed')
);
```

Debe devolver cero filas. El backfill conserva N marcando los N entrantes
contables más recientes por `(created_at,id)`: **inferencia histórica**, no una
reconstrucción de quién leyó qué. No borra mensajes ni reinicializa contadores.
La marca `schema_release=054` impide repetir el backfill al reaplicar. No quitar
esa marca para forzar una reconstrucción en producción.

Después del bundle: ejecutar `check-applied.sql`, comprobar permisos y este
invariante, que debe devolver cero filas:

```sql
SELECT c.id, c.unread_count, count(m.id) FILTER (WHERE m.inbox_unread) AS pending
FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id
GROUP BY c.id HAVING c.unread_count<>count(m.id) FILTER (WHERE m.inbox_unread);
```

Los PATCH antiguos a `unread_count`/revisión se ignoran; el helper de llamadas
conserva firma pero ya no incrementa. Por eso el esquema puede preceder al código
sin perder entrantes ni duplicar conteos. Pedir recarga a las sesiones antiguas:
no incorporan el nuevo reconocimiento. Verificar el commit de la imagen en Coolify
antes del smoke. No revertir eliminando recibos ni poniendo contadores en cero;
la contingencia debe conservar la nueva RPC y la contabilidad transaccional.

Falta acceso confirmado a Coolify/Supabase desplegado, cuenta y destinatario de
WhatsApp de prueba, proveedor IA y teléfonos. No se ejecutó seed ni pruebas sobre
producción. Tras desplegar, comprobar con datos autorizados el contador guardado
antes de abrir la conversación en otra sesión y lo mostrado en cada navegador.
Observar 48 h errores/reintentos y el invariante, sin registrar contenido privado.

Cierre físico pendiente: Safari en iPhone y Chrome en Android, con modelo y
versión registrados; teclado abierto, rotación, alturas pequeñas, archivo/voz,
bloqueo, cambio de aplicación, retorno, pérdida/cambio de red y dos agentes.
Comprobar entrega real a un destinatario de prueba y la ventana expirada.
No declarar ambos bugs cerrados hasta adjuntar esa evidencia y la posterior al
despliegue. Compilación y ausencia visual de una insignia no sustituyen estos pasos.
