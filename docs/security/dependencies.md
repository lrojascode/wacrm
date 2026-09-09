# Estado de vulnerabilidades de dependencias

**Última actualización:** 2026-09-09 · **Comando de referencia:** `pnpm audit --prod`
**Tareas relacionadas:** P0-DEP-01 (✅) · P0-DEP-02 (✅) · P0-DEP-03 (✅) · P0-DEP-04 (pendiente)
**Spec:** [`docs/spec-endurecimiento-piloto.md`](../spec-endurecimiento-piloto.md)

Este documento registra los advisories que **permanecen abiertos a propósito**, con su justificación y su condición de cierre. Un advisory sin entrada aquí es un fallo de proceso, no una excepción aceptada.

---

## Progresión

| Hito | Total | Critical | High | Moderate | Low |
|---|---|---|---|---|---|
| Estado inicial (commit `b4ca21a`) | 52 | 2 | 26 | 21 | 3 |
| Tras P0-DEP-02 (`shadcn` → devDependencies) | 23 | 2 | 13 | 8 | 0 |
| Tras P0-DEP-03 (overrides activos) | 13 | 2 | 6 | 5 | 0 |
| **Tras P0-DEP-01 (`next` 16.3.4)** | **0** | **0** | **0** | **0** | **0** |

---

## Hallazgo de proceso — los `overrides` no se aplicaban

Los seis `overrides` que existían antes de P0-DEP-03 estaban declarados en el campo **`overrides` de nivel superior**, que es el formato de **npm**. pnpm no lo lee: espera `pnpm.overrides` (o el bloque `overrides:` de `pnpm-workspace.yaml`).

Consecuencia: eran configuración muerta. La prueba es directa — el override declaraba `postcss: ^8.5.10` y el árbol de producción resolvía `postcss@8.4.31`, la versión que `next@16.2.6` fija de forma exacta.

**Corregido en P0-DEP-03** moviendo el bloque a `pnpm.overrides`. Tras la corrección, `next@16.2.6` resuelve `postcss: 8.5.23` en `pnpm-lock.yaml` y no queda ninguna referencia a `postcss@8.4.31`.

> **Para quien mantenga esto:** cualquier override nuevo va en `pnpm.overrides`. Verificar siempre que surte efecto inspeccionando la versión resuelta en `pnpm-lock.yaml`, no dando por hecho que la declaración basta.

---

## Advisories abiertos en producción: **ninguno**

`pnpm audit --prod` devuelve **0**. Los 13 advisories que quedaban tras P0-DEP-03 eran todos del árbol de `next` y los cerró la actualización a `next@16.3.4` (P0-DEP-01).

### Corrección de un análisis previo

Antes de P0-DEP-01 este documento afirmaba que `next@16.3.3` **dejaba de declarar `sharp`**, y que por eso sus 2 advisories desaparecerían por eliminación. **Era incorrecto.** La consulta al registry solo miró `dependencies`; `sharp` sigue declarado, en `optionalDependencies`, y `next@16.3.4` lo fija en `^0.35.4` — la versión parcheada.

El resultado práctico coincide (los advisories de `sharp` se cerraron sin necesidad de override), pero el mecanismo era otro: **actualización del rango, no eliminación de la dependencia**. Se deja constancia porque la conclusión "ya no lo declara" habría llevado a decisiones equivocadas si alguien la hubiese arrastrado.

### Advisories fuera de producción (14)

`pnpm audit` sin `--prod` reporta 14 advisories (6 high, 6 moderate, 2 low) en el árbol de **desarrollo**: `brace-expansion` (×6), `qs` (×2), `body-parser`, `@hono/node-server`, `postcss-selector-parser`, `@humanfs/node`, `vitest`, `@vitest/mocker`.

Provienen de `shadcn` (CLI de scaffolding), `eslint` y `vitest`. **No entran en el bundle de producción ni en el runtime del servidor.** El criterio del gate del piloto se mide sobre `--prod`. Se revisan en P0-DEP-04, sin bloquear.

## Overrides activos

Declarados en `pnpm.overrides` de `package.json`. Tras P0-DEP-01 se retiraron los cuatro del árbol de `next` por redundantes — se verificó empíricamente que `pnpm audit --prod` sigue en 0 sin ellos.

| Paquete | Override | Motivo |
|---|---|---|
| `ip-address` | `^10.3.1` | Árbol de herramientas (`shadcn`, devDependency). No afecta a `--prod`; mantiene limpio el entorno de desarrollo. |
| `fast-uri` | `^3.1.6` | Ídem. Cubre seis advisories de confusión de host y SSRF. |
| `hono` | `^4.13.5` | Ídem. Cubre once advisories. |
| `js-yaml` | `^4.3.2` | Ídem. |
| `@babel/core` | `^7.29.6` | Heredado del bloque original; se conserva. |

**Retirados en P0-DEP-01** (verificado: 0 advisories en `--prod` sin ellos):

| Paquete | Por qué ya no hace falta |
|---|---|
| `postcss` | `next@16.3.4` lo fija en `8.5.23`, la versión parcheada. |
| `nanoid` | Llegaba vía `postcss`; se resuelve solo. |
| `browserslist` | `next@16.3.4` ya resuelve `4.28.9` por su cuenta. |
| `baseline-browser-mapping` | `next@16.3.4` ya resuelve `2.11.21` por su cuenta. |

> **Criterio:** un override redundante es deuda — fija una versión que nadie revisa y puede impedir una corrección futura del upstream. Antes de añadir uno, comprobar si el árbol ya resuelve una versión sana; antes de conservarlo, comprobar que sigue haciendo falta.

## Cómo reproducir

```bash
pnpm audit --prod
```

Desglose por módulo y severidad:

```bash
pnpm audit --prod --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=Object.values(JSON.parse(s).advisories);const m={};a.forEach(x=>{m[x.module_name]=m[x.module_name]||{critical:0,high:0,moderate:0,low:0};m[x.module_name][x.severity]++});console.log('TOTAL',a.length);Object.entries(m).forEach(([k,v])=>console.log(' ',k.padEnd(26),JSON.stringify(v)))});"
```

Comprobar que un override surte efecto (no basta con declararlo):

```bash
grep -A3 "next@16.3.4(" pnpm-lock.yaml | grep postcss
```

---

## Deprecaciones tras la actualización a 16.3.4

`AGENTS.md` obliga a atenderlas. De los dos avisos que emitía el build, queda uno.

### 1. `middleware` → `proxy` — ✅ **RESUELTO** (2026-09-09)

```
⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.
```

Aplicado a mano (no con el codemod: el cambio es de dos identificadores y así el diff queda revisable). Documentado en `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md:614-648`.

Cambios:
- `src/middleware.ts` → `src/proxy.ts` y `src/middleware.test.ts` → `src/proxy.test.ts`, ambos con `git mv` para conservar el historial.
- `export async function middleware` → `export async function proxy`. El `export const config` con el `matcher` no cambia.
- Test actualizado (import dinámico y cuatro llamadas).
- Comentarios que citaban `src/middleware.ts` corregidos en `next.config.ts` y `src/lib/branding/server.ts:24`; menciones a la convención actualizadas en cuatro archivos más. Cero referencias a `middleware` en `src/` y `next.config.ts`.

No había flags de config afectados (`skipMiddlewareUrlNormalize` no se usaba). El `edge` runtime no está soportado en `proxy`, pero este archivo no declaraba runtime.

**Verificación en runtime, no solo estática.** Los tests unitarios mockean Supabase: prueban la lógica de la función, **no** que Next invoque el archivo como proxy. Si Next no lo hubiese detectado, el build habría pasado igual y todas las rutas protegidas habrían quedado abiertas. Para descartarlo se levantó el build de producción y se midió el HTTP crudo con `redirect: 'manual'`:

| Ruta | Resultado |
|---|---|
| `/inbox`, `/contacts`, `/settings`, `/pipelines`, `/broadcasts`, `/automations`, `/dashboard` | `opaqueredirect` — 3xx emitido por el servidor |
| `/login` | `200 basic` — sin redirección |

Un `opaqueredirect` en `fetch()` solo puede venir de una respuesta HTTP 3xx. El `router.push("/login")` de `dashboard-shell.tsx:27` no puede producirlo, así que la prueba aísla el proxy del gate de cliente.

### 2. Edge Runtime deprecado — bajo impacto

```
⚠ The Edge Runtime is deprecated. You can use the "nodejs" runtime instead.
```

Origen único: `src/app/icon.tsx:11` (`export const runtime = "edge"`), la ruta que genera el favicon con la marca de la cuenta. Cambiar a `nodejs` es una línea. Sin urgencia de seguridad.

---

## Política

- **P0-DEP-04** añadirá un job de CI que falla ante cualquier advisory `high` o superior.
- Toda excepción exige entrada en este documento con justificación y condición de cierre.
- Ninguna excepción sobrevive al gate del piloto (§10 de la spec): la condición es cero `critical` y cero `high`.
