// ============================================================
// P0-SEC-03 — every route handler must declare who may call it.
//
// This is the test that gives `withRoute` its value. The role helpers
// already existed and already called themselves the single source of
// truth; ten routes simply never called them, and a missing check is
// invisible in review because nothing on the page looks wrong.
//
// So the rule is enforced mechanically: enumerate the route handlers,
// and fail if one makes no role decision at all and is not in the
// allowlist below with a reason. Adding a route without a decision
// about access becomes impossible rather than merely discouraged.
//
// Two forms count as a decision, because the invariant is "someone
// chose who may call this", not "a particular helper was used":
//
//   withRoute({ minRole })  — the wrapper, preferred for new routes
//   requireRole(min)        — the direct call, used by 43 existing
//                             routes that were already correct
//
// Migrating those 43 would be churn with no security gain and real
// regression risk. `getCurrentAccount()` on its own does NOT count: it
// authenticates and resolves the account but decides nothing about
// role, which is exactly the ambiguous middle this test exists to
// eliminate.
// ============================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const API_ROOT = join(process.cwd(), "src", "app", "api");

/**
 * Routes that legitimately run without a signed-in caller, each with
 * the mechanism that authenticates them instead.
 *
 * Adding an entry here is a deliberate act, and the reason is part of
 * the entry: a bare list of paths would rot into "these were failing
 * when someone added the test".
 */
const UNAUTHENTICATED_BY_DESIGN: Record<string, string> = {
  // Meta calls these; authenticated by webhook signature, not session.
  "whatsapp/webhook/route.ts": "Meta webhook — verified by app-secret signature",
  "whatsapp/webhook/[token]/route.ts":
    "Per-account Meta webhook — verified by signature + path token",

  // Invitation acceptance happens before the invitee has an account.
  "invitations/[token]/peek/route.ts": "Pre-session: reads an invitation by token",
  "invitations/[token]/redeem/route.ts": "Pre-session: redeems an invitation by token",
  "invitations/[token]/claim/route.ts":
    "Pre-session: creates the invited user; authenticated by the invitation token itself (P0-SEC-08)",

  // Scheduled work, authenticated by a shared secret header.
  "automations/cron/route.ts": "Cron — x-cron-secret header",
  "flows/cron/route.ts": "Cron — x-cron-secret header",
  "ads/sync/route.ts": "Cron — x-cron-secret header",
};

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listRouteFiles(full));
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full);
  }
  return out;
}

/** Path relative to src/app/api, with POSIX separators. */
function apiPath(file: string): string {
  return relative(API_ROOT, file).split(sep).join("/");
}

function allowlistReason(path: string): string | undefined {
  if (UNAUTHENTICATED_BY_DESIGN[path]) return UNAUTHENTICATED_BY_DESIGN[path];
  // Prefix entries cover a whole subtree (the public API).
  for (const [key, reason] of Object.entries(UNAUTHENTICATED_BY_DESIGN)) {
    if (path === key || path.startsWith(`${key}/`)) return reason;
  }
  return undefined;
}

describe("cada route handler declara quién puede llamarlo", () => {
  const routes = listRouteFiles(API_ROOT).map((file) => ({
    file,
    path: apiPath(file),
    source: readFileSync(file, "utf8"),
  }));

  it("encuentra rutas que auditar", () => {
    // Guards the guard: a broken glob would make every assertion below
    // pass vacuously.
    expect(routes.length).toBeGreaterThan(50);
  });

  it("ninguna ruta con sesión se salta withRoute", () => {
    const offenders = routes
      .filter((r) => !allowlistReason(r.path))
      .filter(
        (r) =>
          !r.source.includes("withRoute") &&
          !/requireRole\s*\(/.test(r.source) &&
          !/requireApiKey\s*\(/.test(r.source),
      )
      .map((r) => r.path);

    expect(
      offenders,
      `Estas rutas no declaran rol.\n\n` +
        `Envuélvelas con withRoute({ minRole: … }) de @/lib/auth/guard, o —si de\n` +
        `verdad deben funcionar sin sesión— añádelas a UNAUTHENTICATED_BY_DESIGN\n` +
        `en este archivo, con el mecanismo que las autentica en su lugar.\n\n` +
        `Ojo: getCurrentAccount() NO basta. Autentica y acota por cuenta, pero\n` +
        `no decide quién puede llamar a la ruta — que es justo el hueco por el\n` +
        `que un viewer podía enviar mensajes de WhatsApp.\n\n` +
        offenders.map((p) => `  - ${p}`).join("\n") +
        "\n",
    ).toEqual([]);
  });

  it("la allowlist no acumula entradas muertas", () => {
    const paths = new Set(routes.map((r) => r.path));
    const stale = Object.keys(UNAUTHENTICATED_BY_DESIGN).filter(
      (key) => !paths.has(key) && ![...paths].some((p) => p.startsWith(`${key}/`)),
    );

    expect(
      stale,
      "Entradas de la allowlist que ya no corresponden a ninguna ruta:\n" +
        stale.map((p) => `  - ${p}`).join("\n"),
    ).toEqual([]);
  });

  it("toda excepción lleva escrito por qué", () => {
    for (const [path, reason] of Object.entries(UNAUTHENTICATED_BY_DESIGN)) {
      expect(reason.length, `La excepción "${path}" necesita una razón`).toBeGreaterThan(15);
    }
  });
});
