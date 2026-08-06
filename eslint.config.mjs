import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
    // Local-only scratch dirs the Supabase CLI writes on `supabase
    // start` (bundled Edge Runtime source, branch snapshots) — already
    // in supabase/.gitignore, but ESLint's flat config doesn't read
    // nested .gitignore files, so without this a local `supabase
    // start` makes the next `pnpm lint` fail on minified vendor code
    // that was never part of this project.
    "supabase/.temp/**",
    "supabase/.branches/**",
  ]),
]);

export default eslintConfig;
