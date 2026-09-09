# Pruebas E2E (Playwright)

**Tarea:** P0-INFRA-01 · **Spec:** [`spec-endurecimiento-piloto.md`](./spec-endurecimiento-piloto.md)

Estas pruebas corren contra la aplicación real y una **pila local de Supabase**. Son el requisito previo del workstream P0-BUG: las diez pruebas del bug de navegación del Inbox no se pueden escribir sin esta infraestructura.

---

## Ejecutar en local

```bash
supabase start
```

```bash
pnpm test:e2e
```

Eso es todo: `globalSetup` siembra los datos y Playwright levanta el servidor de desarrollo si no hay uno escuchando.

Otros comandos:

```bash
pnpm test:e2e:ui
```

```bash
pnpm exec playwright test --project=desktop-chromium
```

```bash
pnpm test:e2e:report
```

La primera vez hay que instalar los navegadores:

```bash
pnpm exec playwright install chromium webkit
```

---

## Cómo está montado

| Pieza | Archivo |
|---|---|
| Configuración, proyectos, servidor | `playwright.config.ts` |
| Catálogo de fixtures (fuente de verdad) | `e2e/support/fixtures.ts` |
| Seed idempotente | `e2e/support/seed.ts` |
| Arranque: carga `.env.local` y siembra | `e2e/global-setup.ts` |
| Ayudante de login | `e2e/support/auth.ts` |
| Smoke | `e2e/smoke.spec.ts` |
| CI | `.github/workflows/e2e.yml` |

**Dos proyectos**, porque el Inbox colapsa a un panel en viewport estrecho y añade un control de volver que el escritorio no renderiza: `desktop-chromium` (1280×800) y `mobile-safari` (iPhone 13). No es cobertura redundante, es otro árbol de componentes.

**Serie, un worker.** Las pruebas comparten una base de datos, así que no están aisladas entre sí. Si la suite se queda corta de tiempo, la solución es una cuenta por worker, no subir el número.

### Datos que siembra

Dos cuentas, porque un fixture de un solo inquilino no puede detectar la clase de fallo que más importa aquí: que los datos de una cuenta se filtren a la sesión de otra.

- **Acme E2E** — los cuatro roles (`owner`, `admin`, `agent`, `viewer`) y tres conversaciones.
- **Globex E2E** — solo un `owner` y una conversación, para ser "la otra cuenta".

Los ids de conversación y contacto son deterministas: las pruebas cross-tenant navegan a una conversación de otra cuenta **sin leerla antes** — leerla exigiría el acceso que precisamente se está probando que se deniega.

Los ids de cuenta **no** son deterministas. Forzarlos exigiría re-keyear la fila que crea el trigger de alta, y `profiles.account_id` la referencia sin `ON UPDATE CASCADE`, así que la FK lo rechaza. El seed los resuelve en tiempo de ejecución.

### Idempotencia

Correr el seed dos veces no duplica nada — verificado comparando conteos entre dos pasadas completas. Un seed que solo funciona sobre un esquema virgen es un seed que nadie ejecuta.

También borra la cuenta que el trigger crea para los usuarios que no son `owner`, para no acumular huérfanas entre ejecuciones. Es seguro precisamente porque nunca se escribió nada en ellas.

### Barrera de seguridad

El seed **se niega a correr contra un Supabase que no sea local**. Crea usuarios y sobrescribe filas por id fijo; apuntarlo a un proyecto compartido sería destructivo. Para saltarlo hace falta `E2E_ALLOW_REMOTE=1` explícito.

---

## Tres trampas que costaron tiempo, documentadas para que no se repitan

### 1. `localhost`, nunca `127.0.0.1`

El servidor de desarrollo de Next 16 solo acepta el handshake del WebSocket de HMR en el origen `localhost`. Pedido por `127.0.0.1` el handshake falla con `ERR_INVALID_HTTP_RESPONSE` y —mucho peor— **la página nunca hidrata**.

Sin hidratación, todos los formularios hacen submit nativo. El login "no hace nada" y recarga `/login` con los campos vacíos y sin mensaje de error: se lee como una contraseña rechazada, no como un problema de transporte. La pista está en la URL, que queda con un `?` suelto al final.

Comprobación rápida, cargando la misma página por ambos hosts:

```bash
node -e "console.log('busca __reactFiber\$ en document.body')"
```

Presente en `localhost`, ausente en `127.0.0.1`.

### 2. Un solo servidor de desarrollo por directorio

Next 16 se niega a arrancar un segundo `next dev` sobre el mismo directorio: detecta el primero y sale con código 1. Por eso la suite usa el puerto **3100** —el mismo de `.claude/launch.json`— y reutiliza el servidor existente, en vez de un puerto dedicado. Con un puerto propio, cualquiera con `pnpm dev` abierto no podría lanzar las pruebas nunca.

### 3. Esperar a la hidratación no es esperar a que los campos tengan valor

Un input sin hidratar es **no controlado**: el texto se queda puesto perfectamente mientras `onSubmit` todavía no existe. Asertar el valor del campo no prueba nada. `e2e/support/auth.ts` espera a la clave `__reactFiber$` que React pone en el `<form>`, que sí es señal de que los handlers están montados.

---

## `data-testid` en producción

Hay exactamente dos, ambos en el Inbox:

- `conversation-list` — `src/components/inbox/conversation-list.tsx`
- `message-thread` — `src/components/inbox/message-thread.tsx`

Existen porque el último mensaje de una conversación se renderiza **en dos sitios a la vez**: como burbuja en el hilo y como línea de vista previa en la lista. Sin acotar, `getByText(...)` resuelve a dos elementos y la aserción pasaría aunque el hilo nunca se hubiera abierto.

Añadir más `data-testid` es aceptable cuando no hay un rol o texto accesible que sirva. Preferir siempre el selector accesible cuando exista.

---

## CI

`.github/workflows/e2e.yml`, separado de `ci.yml` a propósito: aquel corre con credenciales ficticias y sin base de datos, este arranca una pila real en Docker. Un contenedor que falle al arrancar no debe tumbar la señal de lint o typecheck.

`supabase start` aplica `supabase/migrations/*` y `supabase/seed.sql`. Si ese paso falla, la causa casi siempre es una migración que no es idempotente — el mismo fallo que encontraría un cliente en un proyecto nuevo, así que conviene que se vea.

El informe HTML se sube siempre; trazas, capturas y vídeos solo cuando hay fallos.
