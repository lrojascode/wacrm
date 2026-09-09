import { defineConfig } from "vitest/config";

// Two projects, split by file extension.
//
//   *.test.ts   → node    — the long-standing suite: pure logic, route
//                           handlers, SQL helpers. Untouched.
//   *.test.tsx  → jsdom   — React component tests, which need a DOM.
//
// Splitting by extension rather than by directory keeps the rule
// mechanical: there is nothing to remember or configure when adding a
// test, and no way to land a component test in the node project and
// spend an afternoon on a confusing "document is not defined".
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
    },
    clearMocks: true,

    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./src/test-setup.dom.ts"],
        },
      },
    ],
  },
});
