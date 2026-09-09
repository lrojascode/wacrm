// Playwright globalSetup — loads .env.local (Playwright does not read
// it the way Next.js does) and seeds the fixture data once per run.
//
// Failing loudly here is deliberate: a spec that runs against an
// unseeded database produces a confusing cascade of UI timeouts, and
// the real cause — "there is no such user" — never appears in the
// report.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { seed } from "./support/seed";

/**
 * Minimal .env parser. Only fills variables that are not already set,
 * so CI (which exports them directly) always wins over a stray local
 * file. Values may be quoted; everything after the first `=` is the
 * value, so base64 keys with `=` padding survive intact.
 */
function loadEnvFile(relativePath: string): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), relativePath), "utf8");
  } catch {
    return; // absent is fine — CI supplies the vars itself
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export default async function globalSetup(): Promise<void> {
  loadEnvFile(".env.local");
  await seed();
}
