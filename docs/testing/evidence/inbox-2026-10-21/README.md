# Evidencia local — 2026-10-21

Base `6549392`, rama `codex/inbox-read-recovery`, cambios del árbol de trabajo.
Entorno: macOS, Node 22.23.2, Next.js 16.3.8, Supabase CLI 2.117.0 y PostgreSQL 17
local, con Auth, REST, Realtime y Storage. CI está configurado con Node 24.

| Comprobación                                   | Resultado                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Cuatro regresiones antes del arreglo           | 4 fallan por el defecto original; 2 controles pasan; ver [registro anterior](../inbox-before.txt)                              |
| Vitest final                                   | 119 archivos, **1.113 pruebas aprobadas**, sin fallos esperados                                                                |
| Aplicación completa, build de producción local | **144 aprobadas, 12 omisiones previstas**, 0 fallos; Chromium y WebKit                                                         |
| Specs nuevos de Inbox                          | **34 aprobadas**, 6 omisiones porque PostgreSQL se prueba una sola vez; ver [resultados](test-results.json)                    |
| TypeScript y compilación                       | Aprobados; el build también se ejecutó como parte de `E2E_PROD=1`                                                              |
| ESLint                                         | 0 errores; 39 advertencias en el repositorio                                                                                   |
| Instalación nueva                              | `supabase db reset --local`, migraciones 001–054 y seed exclusivamente local                                                   |
| Backfill y reaplicación                        | Preservan N y lecturas posteriores; contadores imposibles abortan                                                              |
| Bundle completo frente a migraciones           | Columnas, políticas, triggers, funciones, restricciones e índices coinciden; ver [comparación](bundle-catalog-comparison.json) |
| Invariante final contador/pendientes           | 0 conversaciones discrepantes                                                                                                  |

El bundle completo se ejecutó sobre un esquema público nuevo dentro de una
transacción local y después se hizo ROLLBACK: se conservaron los datos del banco
E2E. La comparación no confunde los GRANT que el seed/CLI reabre con diferencias
de objetos del esquema.

Las 12 omisiones son 6 escenarios preexistentes que dependen del navegador,
viewport o reproducción diagnóstica, más las 6 pruebas PostgreSQL que se ejecutan
una sola vez y no se repiten en el proyecto WebKit. Ninguna de las cuatro
regresiones de lectura está omitida ni conserva `it.fails`.

## Geometría y capturas

Las dos mediciones cubren 11 tamaños cada una y contienen rectángulos reales de
insignia, estado, campo, enviar, «+» y menú:

- [Chromium](desktop-chromium-geometry.json)
- [WebKit](mobile-safari-geometry.json)

El ancho mínimo observado del campo fue **196 px**. A 1024 px pasó de **34 px**,
antes de ajustar el panel de contacto, a **220 px**. Los botones principales a
anchos menores de 640 px miden **44×44 px**. La ayuda y accesos de escritorio se
mantienen; el panel de contacto se muestra desde 1280 px.

| Motor          | 320 px                                  | 1280 px                                  |
| -------------- | --------------------------------------- | ---------------------------------------- |
| Chromium       | [Captura](desktop-chromium-app-320.png) | [Captura](desktop-chromium-app-1280.png) |
| WebKit emulado | [Captura](mobile-safari-app-320.png)    | [Captura](mobile-safari-app-1280.png)    |

El informe completo de esta pasada está en `playwright-report/index.html`
(ignorado por Git; `pnpm test:e2e:report`). Esta carpeta conserva los datos y
capturas de Inbox para que una ejecución posterior no borre esa evidencia.

## Límites de la conclusión

Son pruebas locales. Meta y la IA externos se sustituyen por el transporte E2E;
Auth, Next.js, PostgreSQL, RLS y Storage son reales. Los logs locales confirmaron
el límite de Realtime de 100 eventos/s al reconocer historiales grandes; se
validó la recuperación y reconciliación, sin aumentar el límite para hacer pasar
la suite. Aún hay que vigilar cuota y latencia en el entorno desplegado.

No se aplicó SQL, seed ni pruebas a producción; no se desplegó una imagen ni se
validó en iPhone/Android físicos. Siguen pendientes esos accesos, la entrega real
a un destinatario de prueba y la observación de 48 h. El cierre operativo y el
preflight están en [la guía principal](../../inbox-unread-and-mobile.md).
