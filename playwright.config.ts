import { defineConfig, devices } from "@playwright/test";

// ============================================================
// E2E configuration.
//
// Port 3100 — the same one .claude/launch.json uses — and the suite
// reuses a server that is already listening there.
//
// A dedicated port was the first instinct, but Next 16 refuses to run
// a second dev server for the same directory: it detects the first and
// exits 1. So a developer with `pnpm dev` already open could never run
// the suite. Reuse is also honest here in a way it would not be for a
// production build — a dev server always serves the current working
// tree, so there is no "which build is this?" ambiguity to guard
// against.
//
// The dev server, not a production build. These specs assert routing,
// session handling and authorisation, all of which run identically in
// dev, and rebuilding on every run would make the suite too slow to
// use while fixing a bug. Anything that asserts production-only
// behaviour — the Cache-Control rules in next.config.ts, for instance,
// which Next overrides in dev — needs its own project against
// `next start`.
// ============================================================

const PORT = Number(process.env.E2E_PORT ?? 3100);
// `localhost`, NOT `127.0.0.1`. The Next 16 dev server only accepts the
// HMR WebSocket handshake on the localhost origin; requested over
// 127.0.0.1 the handshake fails with ERR_INVALID_HTTP_RESPONSE and,
// far worse, the page never hydrates. Every form on the site then
// submits natively, which surfaces as "login does nothing" rather than
// as anything resembling a transport problem. Verified by loading the
// same page over both hosts and checking for React's `__reactFiber$`
// keys on document.body: present on localhost, absent on 127.0.0.1.
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

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
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
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
    command: `pnpm run dev --port ${PORT}`,
    url: BASE_URL,
    // Turns on the P0-BUG-01 auth tracing so the diagnostic spec can
    // read the timeline. Inert everywhere else: the trace module is a
    // no-op unless this is exactly "1".
    //
    // Note this only applies to a server Playwright starts itself. With
    // `reuseExistingServer`, a dev server already running without the
    // flag is used as-is and the diagnostic spec will skip.
    env: { NEXT_PUBLIC_AUTH_TRACE: "1" },
    // Locally, reuse a server the developer already has running.
    reuseExistingServer: !process.env.CI,
    // A cold Next dev server compiles routes on demand; the first
    // navigation of a run is far slower than the rest.
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
