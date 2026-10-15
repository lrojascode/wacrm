# Continuidad visual del Inbox

El Inbox debe vivir en el layout estático `/inbox`, por encima del segmento
`[[...conversationId]]`. Compartir el nombre del archivo de página no conserva
su estado: Next.js incluye el valor del parámetro dinámico en la clave del árbol.

## Regresión confirmada antes del arreglo

El commit `14bc368` añade únicamente una prueba de navegación real. En el
[run de referencia](https://github.com/lrojascode/wacrm/actions/runs/38646563494)
falló en Chromium de escritorio y WebKit móvil porque los contenedores originales
se desconectaban del documento después de seleccionar otra conversación.
Las otras 106 pruebas pasaron; las 6 omisiones son las previstas por la suite.
El run conserva screenshot, vídeo y trace del fallo.

Las pruebas anteriores de componente simulaban el cambio con `rerender` y no
reproducían la identidad de los segmentos del App Router. El E2E anterior comprobaba
la vista antes de confirmar la ruta y el resultado final, dejando sin comprobar
el intervalo de carga de la nueva conversación.

## Contrato del arreglo

- La lista y el área de mensajes conservan sus nodos al cambiar de ruta. La lista
  no vuelve a consultar por el simple cambio de chat.
- Un hilo nuevo muestra el encabezado correcto y burbujas skeleton estáticas.
  El composer y las acciones que requieren mensajes esperan la carga inicial.
- Un hilo almacenado muestra sus mensajes, borrador de texto y lugar de lectura
  inmediatamente, incluso si la revalidación está retenida o falla.
- La caché vive solamente en memoria del Inbox, aislada por usuario y cuenta.
  Conserva 20 hilos recientes; los envíos pendientes y el hilo activo están
  protegidos, por lo que temporalmente puede exceder ese límite. Se limpia al
  salir del Inbox, cambiar de cuenta o confirmar el cierre de sesión.
- Respuestas, reacciones, adjuntos, grabaciones y consultas del contacto no
  contaminan otra conversación. Un fallo de lookup de un enlace directo permite
  reintentar sin abandonar la bandeja.
- Los adjuntos sin enviar se limpian al abandonar su composer; la conservación
  por conversación corresponde a los borradores de texto.

## Ejecutar y revisar la evidencia

```sh
pnpm test
pnpm run lint
pnpm run typecheck
pnpm run build
E2E_PROD=1 pnpm exec playwright test
```

El workflow E2E arranca el Supabase reducido en un runner aislado, construye el
artefacto de producción y ejecuta Chromium y WebKit. Los tests de transición
retienen respuestas y adjuntan capturas **durante** la espera, al volver a un
hilo almacenado y después de una selección rápida A → B → C. Revisar los
adjuntos en el artefacto `playwright-report` y los checks del PR correspondiente.

La suite E2E usa usuarios y conversaciones de prueba con un seed; la comprobación
del CRM desplegado consiste en navegar entre chats autorizados, sin ejecutar
ese seed contra su base de datos. Antes de atribuir el resultado al arreglo,
verificar en Coolify el commit de la imagen desplegada. No hay migraciones ni
variables de aplicación nuevas para este cambio.
