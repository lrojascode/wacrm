# Investigación: conversaciones respondidas que reaparecen como no leídas

Fecha: 2026-10-21. Código investigado: `6549392`.

## Conclusión

Hay cuatro defectos reproducibles en el cliente. Dos impiden persistir la lectura, uno inventa no leídos con mensajes salientes y otro impide recuperarse de un fallo temporal al guardar la lectura. El envío de respuestas no corrige por sí mismo el contador persistido.

La reproducción más cercana al reporte es: seleccionar desde la lista una conversación con un no leído, responder, volver a la lista y resincronizar. El servidor simulado conserva `unread_count = 1`; la lista vuelve a mostrarlo. Como control, una carga directa del mismo chat con `unread_count = 1` sí emite la actualización a cero.

Esto explica mecanismos suficientes para producir el síntoma. No establece cuál ocurrió en cada conversación real: no se consultaron datos, logs ni la versión desplegada de producción, ni se probó en los teléfonos de las usuarias.

## Evidencia y alcance de las pruebas

Archivo: `src/components/inbox/unread-investigation.test.tsx`.

Se ejecutan **InboxWorkspace, MessageThread, useInboxMessages y useMessageSync reales**. Se simulan Supabase, la confirmación de navegación, la llegada de eventos de Realtime, la carga de la lista y el envío HTTP. Los componentes periféricos se sustituyen para aislar la coordinación entre lista, hilo y lectura.

El backend simulado conserva el contador entre cargas; las actualizaciones a cero modifican ese estado únicamente si el componente realmente las solicita. La simulación de Realtime permite entregar INSERT y UPDATE por separado. El retorno de pestaña se conduce mediante `visibilitychange`; no representa la suspensión real de iOS o Android.

| Caso                                                            | Comportamiento observado                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Carga directa de B con contador 1                               | Se solicita guardar cero y el servidor simulado queda en cero.        |
| Seleccionar B desde la lista, responder, volver y resincronizar | La respuesta aparece como enviada, pero el servidor conserva 1.       |
| INSERT entrante + UPDATE con contador 1 para el chat abierto    | Se ve el mensaje, pero no se solicita guardar la lectura.             |
| INSERT saliente de otro chat con contador inicial 0             | El cliente muestra 1 aunque el mensaje sea del agente.                |
| UPDATE posterior de ese otro chat con contador 0                | Repara el no leído falso: depende de que llegue ese segundo evento.   |
| Fallo temporal al guardar lectura + retorno a visible           | Solo hay un intento de guardado; la resincronización no lo reintenta. |

Las cuatro expectativas de comportamiento correcto fallaron también en una ejecución sin `it.fails`: contador persistido 1 en vez de 0; cero llamadas de lectura; indicador falso 1; un intento en vez de dos. En el archivo se dejan como **fallos esperados**, no como correcciones. Quitar `.fails` al resolver cada defecto permite convertirlas en regresiones normales. Si cambia el motivo del fallo, hay que inspeccionar la excepción: una prueba de fallo esperado no sustituye la revisión de su causa.

Comando:

```sh
pnpm exec vitest run src/components/inbox/unread-investigation.test.tsx --reporter=verbose
```

Resultado: 2 controles pasan y 4 fallos esperados se reproducen. Además, 46 pruebas existentes de workspace, hilo, estado de mensajes, envío y webhook pasan. `pnpm run typecheck` pasa.

## 1. Seleccionar desde la lista elimina la señal que dispara el guardado

Prioridad alta. Confirmado en la reproducción.

Ubicaciones:

- `src/components/inbox/inbox-workspace.tsx:48`: el chat activo se deriva de `conversations`.
- `src/components/inbox/inbox-workspace.tsx:545`: seleccionar un chat pone su contador local en cero antes de navegar.
- `src/components/inbox/message-thread.tsx:351`: `hasUnread` se calcula desde ese contador.
- `src/components/inbox/message-thread.tsx:465`: el guardado solo ocurre si `hasUnread` es verdadero.

Secuencia:

1. Base de datos y lista tienen B con un no leído.
2. El clic cambia `conversations[B].unread_count` a cero.
3. Se confirma la navegación a B.
4. El chat activo se obtiene de esa misma lista y ya tiene cero.
5. El efecto retorna sin enviar la actualización de lectura a Supabase.
6. La usuaria responde. El envío guarda el mensaje y actualiza la vista previa, pero conserva el contador del servidor.
7. Al volver a la lista y recargarla, vuelve el valor 1.

El comentario del manejador afirma que deja intacto el contador del chat activo mientras cambia una copia para la lista. Esa separación ya no existe. El commit `932bdc7`, del 2026-10-14, contiene la derivación actual y ese comentario incompatible con ella. Es un punto concreto para revisar el historial de la regresión; no se verificó si ese commit está desplegado ni se ejecutó una comparación con su padre.

## 2. Los eventos del chat abierto ocultan el contador sin persistir la lectura

Prioridad alta. Confirmado con INSERT y UPDATE controlados.

En `inbox-workspace.tsx:264`, un INSERT del chat activo fuerza cero localmente. En `inbox-workspace.tsx:344`, un UPDATE de la conversación activa también reemplaza el contador recibido por cero.

El webhook puede guardar 1 y emitirlo correctamente; el workspace lo convierte a cero antes de que MessageThread lo vea. El efecto encargado de guardar la lectura nunca recibe la condición que necesita.

Esto deja dos estados distintos: pantalla aparentemente leída y base de datos todavía no leída. Una recarga, otro dispositivo o una resincronización pueden hacer visible la discrepancia.

## 3. Un mensaje saliente también incrementa el contador local

Prioridad media. Confirmado; su persistencia visual depende de perder o retrasar la reconciliación posterior.

En `inbox-workspace.tsx:264`, cualquier INSERT de un chat no activo suma uno. No comprueba `sender_type`.

Por tanto, una respuesta de otra agente, un bot u otro proceso puede crear un no leído falso en esta sesión. El cliente no escribe ese incremento en la base de datos; es un error de su estado local.

El UPDATE posterior de la conversación suele corregirlo, como demuestra el segundo control. Si se pierde ese UPDATE, queda hasta la siguiente resincronización. No se demostró que un teléfono real haya perdido precisamente ese evento; la prueba demuestra el resultado de entregarlo y de omitirlo.

## 4. Un fallo de guardado no se reintenta al retomar el navegador

Prioridad media. Confirmado con un error devuelto por Supabase.

`message-thread.tsx:465` depende únicamente de `[conversationId, hasUnread]`. Si guardar cero falla, solo escribe un error en la consola. No conserva una operación pendiente ni ofrece recuperación específica.

Al volver a visible, el workspace recarga datos. Si el contador sigue siendo positivo, `hasUnread` sigue siendo `true`: las dependencias no cambian y el efecto no vuelve a ejecutarse. Un cambio de 1 a 2 tampoco cambia ese booleano.

Una nueva carga completa puede volver a intentarlo porque monta otra vez el efecto. Eso hace posible que dos sesiones parezcan comportarse de forma distinta sin existir lógica específica por dispositivo.

## Por qué encaja con el uso móvil y con entrar desde otro navegador

La selección normal desde la lista está afectada tanto en escritorio como en móvil. No se encontró una condición que marque leído solo en escritorio.

En móvil, la lista y el chat se muestran como paneles alternos. Es habitual regresar a `/inbox` para cambiar de conversación. El listener de `visibilitychange` del workspace vuelve a cargar la lista cuando el documento pasa a visible. Si se retorna mientras está en la lista, reaparece el valor positivo persistido. Si se retorna con el chat abierto, la carga del valor positivo puede activar el guardado y corregirlo. Este segundo recorrido también puede ocurrir en escritorio.

El control de carga directa confirma otra vía de recuperación: al montar el chat desde su URL, sin el clic que borra el contador, el efecto recibe el valor positivo y lo guarda como leído.

Además, `unread_count` es un campo de la conversación compartida, no un estado por agente o navegador. Si una sesión consigue guardarlo en cero, cambia el dato que ven las demás. Una sesión que pierda ese evento puede seguir mostrando su copia antigua.

Estos recorridos son compatibles con lo observado; no prueban qué navegador, sistema operativo o estado de visibilidad estaba implicado en los casos originales.

## Revisión del servidor y riesgos adicionales

### Responder no modifica el contador persistido

`src/lib/whatsapp/send-message.ts:483` actualiza la vista previa y las fechas, pero no `unread_count`. La ruta de envío no compensa un guardado de lectura omitido por el cliente. Se verificó por lectura del código; el envío al servicio real de Meta no se ejecutó.

No conviene corregirlo poniendo cero indiscriminadamente en cada envío: una automatización no implica que una persona haya leído el hilo y podría entrar un mensaje nuevo durante el envío.

### Incremento del webhook basado en un valor leído antes

`src/lib/whatsapp/webhook-processing.ts:765` escribe `(conversation.unread_count || 0) + 1`, utilizando la conversación consultada al comienzo del procesamiento.

La operación no es un incremento atómico. Dos mensajes concurrentes pueden leer el mismo N y escribir ambos N+1. También puede cruzarse con una actualización de lectura y escribir un valor basado en un estado anterior. Es un riesgo sustentado por el código, **no una carrera reproducida aquí con Postgres real**. Resolver solo la representación visual no resuelve esta coordinación.

### Otros límites del seguimiento de lectura

- El efecto no comprueba que el historial haya terminado de cargar ni que el documento esté visible. Puede marcar leído antes de que los mensajes se hayan mostrado. Es una observación del código, no una nueva reproducción de dispositivo.
- `useTotalUnread` tiene su propio estado y canal. No recarga al volver a visible ni al reconectar; el indicador general del menú puede quedar desactualizado independientemente de la lista.
- La lista reemplaza su snapshot cuando termina una consulta. Un evento más reciente recibido mientras esa consulta está en vuelo podría ser sustituido por el resultado antiguo. No se reprodujo esta carrera adicional.
- Las políticas del repositorio permiten actualizar conversaciones a miembros con rol agente. No hay evidencia para atribuir el reporte a permisos, pero no se verificaron las políticas efectivamente aplicadas a producción.

## Corrección propuesta

1. Hacer que el reconocimiento de lectura sea una operación explícita y persistente, independiente del contador optimista usado para dibujar la insignia. No borrar la única señal que debe activar esa operación.
2. Reconocer los mensajes mostrados cuando el chat esté visible y el historial haya cargado; no dar por leído un chat solo porque su ID sigue seleccionado en una pestaña oculta.
3. Coordinar los cambios de contador en el servidor. Una marca de lectura hasta un mensaje entrante concreto, con orden estable, permite conservar los mensajes que lleguen después. Un incremento atómico resuelve incrementos perdidos, pero por sí solo no resuelve todas las carreras con el reconocimiento de lectura.
4. Reintentar reconocimientos pendientes tras fallos y al recuperar visibilidad, conexión o Realtime, con deduplicación y sin bucles de escrituras.
5. No incrementar no leídos al recibir INSERT de mensajes salientes. Evitar contar dos veces un mismo entrante mediante el INSERT y el UPDATE de su conversación.
6. Verificar dos sesiones, navegación lista-chat-lista, carga directa, mensajes concurrentes, retorno de móvil y fallos de red. Validar por separado el contador guardado y la insignia de cada sesión.

## Cómo distinguir los dos tipos de fallo en producción

Con una conversación afectada, comparar su `unread_count` persistido con el número que ve cada sesión, sin abrir antes ese hilo en otra sesión para no alterar la evidencia.

- Persistido positivo después de leer: investigar el reconocimiento omitido, fallido o sobrescrito.
- Persistido cero con insignia positiva: investigar el incremento local de salientes, eventos perdidos o snapshots antiguos.

Registrar únicamente IDs, contador, ruta, visibilidad, resultado del guardado y secuencia de eventos permite determinar cuál ocurre sin capturar el contenido privado de los mensajes. No se añadió instrumentación ni se modificaron datos reales en esta investigación.

## Cambios entregados

Solo este informe y las seis pruebas diagnósticas. No se modificó lógica de producción, no se aplicaron migraciones y no se desplegó ningún cambio.
