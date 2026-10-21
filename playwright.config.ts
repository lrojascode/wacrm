import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// E2E process only; never enable real external sends by forgetting a flag.
process.env.E2E_PROVIDER_MOCKS ??= "1";

// Next dev is the fast default; E2E_PROD=1 validates the production build.
// Provider doubles must be installed before Node starts, so an uninstrumented
// existing dev server cannot be reused. Stop it before starting this suite.
// Port 3100 matches .claude/launch.json; all mutations target local Supabase.

const PORT = Number(process.env.E2E_PORT ?? 3100);

/** Correr contra un build de producción en vez de `next dev`. */
const PROD = process.env.E2E_PROD === "1";
// `localhost`, NOT `127.0.0.1`. The Next 16 dev server only accepts the
// HMR WebSocket handshake on the localhost origin; requested over
// 127.0.0.1 the handshake fails with ERR_INVALID_HTTP_RESPONSE and,
// far worse, the page never hydrates. Every form on the site then
// submits natively, which surfaces as "login does nothing" rather than
// as anything resembling a transport problem. Verified by loading the
// same page over both hosts and checking for React's `__reactFiber$`
// keys on document.body: present on localhost, absent on 127.0.0.1.
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE_URL).hostname)) {
  throw new Error(
    "E2E_BASE_URL must be loopback; this suite must never operate on production",
  );
}

export default defineConfig({
  testDir: "./e2e",
  // Only spec files are tests; ./e2e/support holds helpers.
  testMatch: /.*\.spec\.ts$/,

  // Seeds fixture data before anything runs. See e2e/global-setup.ts.
  globalSetup: "./e2e/global-setup.ts",

  // A shared Supabase stack means specs are not isolated from each
  // other's writes, so they run serially. Correctness first; if the
  // suite outgrows this, the fix is a per-worker account, not a
  // higher number here.
  fullyParallel: false,
  workers: 1,

  // Never let a stray `test.only` pass silently on CI.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,

  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    // Artefacts only for failures — a green run should leave nothing
    // behind to sift through.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
  },

  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      // The inbox collapses to a single pane on narrow viewports and
      // grows a back control that desktop never renders, so the mobile
      // project is not redundant coverage — it exercises a different
      // component tree.
      name: "mobile-safari",
      use: { ...devices["iPhone 13"] },
    },
  ],

  webServer: {
    // `E2E_PROD=1` corre la suite contra un build de producción.
    //
    // Existe por la CSP (P0-SEC-10): en desarrollo React usa `eval`
    // para reconstruir stacks de error, así que la política necesita
    // `unsafe-eval` ahí y no en producción. Medir las violaciones
    // contra `next dev` daría por buena una política que en producción
    // podría romper —o al revés, exigiría un permiso que sobra— así
    // que la comprobación seria se hace contra el artefacto real.
    //
    // También cambia qué se sirve: en dev, base-server.js pisa
    // Cache-Control en cada página, lo que esconde las reglas de
    // caché de next.config.
    command: PROD
      ? `pnpm run build && pnpm run start --port ${PORT}`
      : `pnpm run dev --port ${PORT}`,
    url: BASE_URL,
    // Turns on the P0-BUG-01 auth tracing so the diagnostic spec can
    // read the timeline. Inert everywhere else: the trace module is a
    // no-op unless this is exactly "1".
    //
    // Note this only applies to a server Playwright starts itself. With
    // `reuseExistingServer`, a dev server already running without the
    // flag is used as-is and the diagnostic spec will skip.
    env: {
      NEXT_PUBLIC_AUTH_TRACE: "1",
      ...(process.env.E2E_PROVIDER_MOCKS === "1"
        ? {
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${resolve("e2e/support/provider-mocks.mjs")}`,
          }
        : {}),
    },
    // Reuse is allowed only when explicitly disabling the E2E transport.
    // Un servidor de dev que ya esté corriendo no sirve para la pasada
    // de producción: reutilizarlo mediría el artefacto equivocado.
    reuseExistingServer:
      !process.env.CI && !PROD && process.env.E2E_PROVIDER_MOCKS !== "1",
    // A cold Next dev server compiles routes on demand; the first
    // navigation of a run is far slower than the rest.
    // Un build completo tarda más que arrancar `next dev` en frío.
    timeout: PROD ? 420_000 : 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
