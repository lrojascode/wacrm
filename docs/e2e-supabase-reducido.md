# Pruebas con Supabase reducido

El perfil de pruebas conserva PostgreSQL, GoTrue (autenticación), PostgREST
(API REST), Kong (gateway) y Realtime. Omite Studio, postgres-meta, Edge
Functions, Logflare, Vector, Supavisor, Storage, imgproxy y Mailpit.

Las pruebas actuales usan conversaciones de texto y usuarios confirmados por
la API administrativa. No prueban cargas de archivos ni correos de recuperación.
Para añadir esos escenarios hay que volver a incluir Storage o Mailpit.
Las migraciones del CRM se aplican completas, incluidas las políticas del esquema
`storage`; omitir su servidor HTTP no elimina esas migraciones.
El CLI puede descargar y usar la imagen de Storage una vez para inicializar
su esquema, aunque el servidor no quede levantado.

## Ejecución local

Requiere Docker, Supabase CLI 2.117.0 y Node 24. Desde la raíz del proyecto:

```bash
pnpm run supabase:start:test
```

Si este proyecto ya está levantado con todos los servicios, ejecutar primero
`supabase stop` sin `--no-backup` y después el comando anterior. No se detienen
otros proyectos ni se eliminan sus volúmenes.

Configurar en `.env.local` las credenciales **locales** que devuelve
`supabase status`: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`. El seed de Playwright
crea usuarios y datos de prueba; nunca apuntarlo a producción.

```bash
pnpm exec playwright install chromium webkit
pnpm run test:e2e
```

Para una pasada enfocada en el Inbox y sus regresiones:

```bash
pnpm run test:e2e e2e/inbox-sync.spec.ts e2e/inbox-navigation.spec.ts e2e/auth-trace.spec.ts
```

El perfil reduce descargas y consumo de memoria, pero no libera imágenes ya
descargadas. PostgreSQL sigue necesitando espacio en el disco interno de Docker;
si el límite está lleno, omitir servicios no basta por sí solo.

## GitHub Actions

El workflow `.github/workflows/e2e.yml` ejecuta este mismo perfil y la suite
completa en Chromium de escritorio y WebKit con el dispositivo iPhone 13.
Arranca una base local descartable en el runner, exporta sus credenciales y
conserva el informe de Playwright y los traces de errores como artefactos.
Se activa al abrir o actualizar un PR hacia `main` y al hacer push a `main`.
No utiliza el disco de Docker de tu Mac.

Para levantar todas las herramientas de desarrollo, usar `supabase start`.
La exclusión de servicios está documentada en
[Supabase CLI](https://supabase.com/docs/reference/cli/supabase-start).
