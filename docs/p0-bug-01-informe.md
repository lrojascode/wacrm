# P0-BUG-01 — Informe: qué evento precede a cada expulsión

**Fecha:** 2026-09-09 · **Método:** reproducción determinista, no telemetría
**Instrumentación:** `src/lib/diagnostics/auth-trace.ts` · **Reproducción:** `e2e/auth-trace.spec.ts`

---

## Respuesta

> Un evento **`SIGNED_OUT` con sesión nula**, entre 3 y 8 ms antes de la expulsión.
>
> Lo dispara un **fallo de refresh no reintentable** (`refresh_token_not_found`) sobre un access token ya caducado. **No** lo disparan ni el simple retorno de pestaña, ni la pérdida de la cookie, ni un fallo de red en el refresh.

Timeline capturado, en `/inbox` con una conversación abierta:

```
   429ms  visibility  hidden          vis=hidden   cookie=sí  session=-    /inbox
  1438ms  visibility  visible         vis=visible  cookie=sí  session=-    /inbox
  1474ms  auth-event  SIGNED_OUT      vis=visible  cookie=NO  session=NO   /inbox
  1477ms  expulsion   shell:no-user   vis=visible  cookie=NO  session=-    /inbox
  URL final: /login
```

---

## Cómo se obtuvo

El plan original pedía 24 h de telemetría en staging con uso real. Con la infraestructura E2E de P0-INFRA-01 ya en pie, la misma pregunta se responde en segundos y con mejor evidencia: una reproducción se puede volver a ejecutar contra el arreglo; una muestra de logs no.

La instrumentación registra cada evento de `onAuthStateChange`, cada cambio de visibilidad y cada expulsión del shell. Guarda en **`sessionStorage`, no en memoria**, porque el fallo termina en una navegación completa de documento: un array a nivel de módulo muere justo en el instante que hay que capturar.

Cada entrada anota si la **cookie de sesión seguía presente**. Ese es el dato que separa un cierre de sesión legítimo de uno espurio, y ninguna consola ni log de servidor lo distingue por su cuenta.

Se descarta el resto por eliminación:

| Condición probada | ¿Evento de auth? | ¿Expulsión? |
|---|---|---|
| Retorno de pestaña, sesión fresca | **ninguno** | no |
| Cookie de sesión borrada + retorno | ninguno | no |
| Token caducado + refresh con **fallo de red** (6 intentos) | ninguno | no |
| Token caducado + refresh con **`refresh_token_not_found`** | **`SIGNED_OUT`** | **sí** |

---

## Correcciones al análisis previo

La spec afirmaba en §2.3 dos cosas que estos datos **refutan**. Se corrigen ahí; se dejan registradas aquí porque llevaron el análisis en una dirección equivocada.

### 1. «auth-js emite un evento de auth en cada retorno a la pestaña»

**Falso, medido.** Con una sesión válida y no próxima a caducar, un ciclo `hidden → visible` produce **cero** eventos. `_recoverAndRefresh` solo notifica cuando algo cambia.

El razonamiento original venía de leer que `_recoverAndRefresh` termina en `_notifyAllSubscribers('SIGNED_IN', …)`, sin comprobar que esa rama se alcanza en la práctica. Leer el código no sustituyó a medirlo.

*Salvedad honesta:* la visibilidad se conduce redefiniendo `document.visibilityState` y despachando el evento, no con un cambio de pestaña real del sistema operativo. Un navegador real podría además disparar `focus`, congelar temporizadores o suspender la pestaña. La conclusión —que un retorno **por sí solo** no expulsa— es firme; que jamás emita evento alguno, lo es menos.

### 2. «Un fallo de refresh basta para provocar un `SIGNED_OUT`»

**Falso, y auth-js se defiende de esto activamente.** Con el endpoint de refresh caído se interceptaron **6 intentos** y la sesión se conservó intacta. El propio comentario de `_recoverAndRefresh` (GoTrueClient.js:4008-4014) advierte de no eliminar la sesión ahí, precisamente para no romper una sesión todavía válida.

Solo un rechazo **definitivo** del servidor la elimina. Es decir: la ventana del fallo es más estrecha de lo que decía el análisis, y apunta directamente a la **carrera de rotación** entre auth-js y el proxy, que compiten por rotar el mismo refresh token — no a la fragilidad de red.

### 3. Lo que sigue sin reproducirse

En la reproducción la cookie **ya no está** cuando ocurre la expulsión (`cookie=NO`), así que el usuario aterriza en `/login`, no en `/dashboard`.

El síntoma reportado —acabar en el inicio— exige la otra mitad de la carrera: que el **proxy** haya escrito una cookie nueva y válida mientras el cliente descartaba la suya. Entonces `dashboard-shell` empuja a `/login`, el proxy ve sesión válida y rebota a `/dashboard` (`src/proxy.ts:51-70`).

Esa mitad no se puede forzar desde el test, porque exige que dos procesos roten el mismo token en la misma ventana. **La traza sigue siendo necesaria en staging para confirmarla**, y ahora sabe distinguirla: una expulsión con `cookie=sí` es exactamente ese caso.

---

## Qué queda confirmado del análisis

| Defecto | Estado |
|---|---|
| **A** — El estado del Inbox vive bajo un gate que desmonta a sus hijos | Confirmado por lectura de código, y la expulsión reproducida lo ejerce: se pierde la conversación abierta |
| **B** — Un `SIGNED_OUT` se convierte en `router.push("/login")` sin confirmar | **Confirmado con timeline.** El disparador era más estrecho de lo descrito |
| **C** — `router.replace` no deja historial por conversación | Confirmado y **corregido** en P0-BUG-04: la ruta es ahora `/inbox/<id>` y la selección usa `push` |
| **D** — Deep link resuelto solo en cliente | Confirmado y **corregido** en P0-BUG-05 |

---

## Implicaciones para el arreglo

1. **P0-BUG-03 sigue siendo correcto y necesario.** Confirmar el `SIGNED_OUT` con un `getUser()` antes de actuar convierte la expulsión en un no-evento cuando la sesión es recuperable. El margen entre el evento y la expulsión es de 3 ms: hoy no hay ninguna oportunidad de verificar nada.
2. **P0-BUG-02 gana importancia.** La expulsión puede ocurrir con la pestaña oculta, así que el usuario no la ve suceder: vuelve y ya está fuera. Mantener el árbol montado evita que el estado se destruya aunque la redirección llegue a dispararse.
3. **Merece la pena mirar la rotación del proxy.** `src/proxy.ts:26` llama a `getUser()` en cada petición que casa con el matcher, incluidos prefetches de RSC. Cada una puede rotar el refresh token. Reducir esa superficie —o coordinar la rotación— ataca la causa en vez del síntoma.
4. **`expect(expulsions).toBeGreaterThan(0)` en `e2e/auth-trace.spec.ts` documenta el comportamiento de hoy.** Cuando P0-BUG-03 aterrice, esa aserción hay que invertirla de forma deliberada y dejando constancia del motivo.

---

## Uso en staging

```bash
NEXT_PUBLIC_AUTH_TRACE=1
```

En la consola del navegador, tras reproducir el fallo:

```bash
__authTrace()
```

Una expulsión que aparezca con `hasAuthCookie: true` es la mitad de la carrera que aún no se ha reproducido en local. Adjuntar la traza al hilo de P0-BUG.
