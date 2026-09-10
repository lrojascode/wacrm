// P0-SEC-01/02 — the role ladder, exercised end to end through the
// wrapper every route now goes through.
//
// The matrix is the point: for each minimum role, every role at or
// above it gets in and every role below it gets 403. Asserting one
// happy path and one denial would miss an off-by-one in `hasMinRole`,
// which is the mistake that would silently hand `agent` the `admin`
// surface.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountContext } from "@/lib/auth/account";
import { ACCOUNT_ROLES, type AccountRole } from "@/lib/auth/roles";

/** What the fake database should report for the next call. */
let currentRole: AccountRole | null = "viewer";
let sessionMissing = false;
/** P0-SEC-08: whether the signed-in user has a verified address. */
let emailVerified = true;

/**
 * Mock the Supabase client, not `getCurrentAccount`.
 *
 * Mocking the resolver was the first attempt and it silently did
 * nothing: `requireRole` calls `getCurrentAccount` through its own
 * module scope, so replacing the export never intercepts it. Faking the
 * client one layer down means the real getCurrentAccount → requireRole →
 * hasMinRole chain runs, which is the chain worth testing.
 */
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () =>
        sessionMissing
          ? { data: { user: null }, error: { message: "no session" } }
          : {
              data: {
                user: {
                  id: "u1",
                  email_confirmed_at: emailVerified ? "2026-01-01T00:00:00Z" : null,
                },
              },
              error: null,
            },
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === "profiles"
              ? { data: { account_id: "a1", account_role: currentRole }, error: null }
              : { data: { id: "a1", name: "Acme" }, error: null },
        }),
      }),
    }),
  }),
}));

const { withRoute } = await import("./guard");

const handler = vi.fn(async () => Response.json({ ok: true }));
const request = () => new Request("https://app.test/api/thing", { method: "POST" });

beforeEach(() => {
  handler.mockClear();
  sessionMissing = false;
  currentRole = "viewer";
  emailVerified = true;
});

describe("withRoute — matriz de roles", () => {
  const RANK: Record<AccountRole, number> = {
    viewer: 1,
    agent: 2,
    admin: 3,
    owner: 4,
  };

  for (const minRole of ACCOUNT_ROLES) {
    for (const callerRole of ACCOUNT_ROLES) {
      const allowed = RANK[callerRole] >= RANK[minRole];

      it(`minRole=${minRole} · ${callerRole} → ${allowed ? "200" : "403"}`, async () => {
        currentRole = callerRole;
        const route = withRoute({ minRole }, handler);

        const res = await route(request());

        expect(res.status).toBe(allowed ? 200 : 403);
        expect(handler).toHaveBeenCalledTimes(allowed ? 1 : 0);
      });
    }
  }
});

describe("withRoute — casos límite", () => {
  it("sin sesión devuelve 401, no 403", async () => {
    // La distinción importa: 401 dice "identifícate", 403 dice "no
    // puedes". Confundirlas manda al usuario a arreglar lo que no es.
    sessionMissing = true;
    const route = withRoute({ minRole: "viewer" }, handler);

    const res = await route(request());

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("el handler recibe el contexto ya resuelto", async () => {
    currentRole = "admin";
    let seen: AccountContext | undefined;
    const route = withRoute({ minRole: "agent" }, async (ctx) => {
      seen = ctx;
      return Response.json({ ok: true });
    });

    await route(request());

    expect(seen?.accountId).toBe("a1");
    expect(seen?.role).toBe("admin");
  });

  it("reenvía los argumentos de una ruta dinámica", async () => {
    currentRole = "owner";
    const params = { params: Promise.resolve({ id: "x1" }) };
    let seen: unknown;
    const route = withRoute<[typeof params]>(
      { minRole: "viewer" },
      async (_ctx, _request, forwarded) => {
        seen = forwarded;
        return Response.json({ ok: true });
      },
    );

    await route(request(), params);

    expect(seen).toBe(params);
  });

  // Un fallo del handler NO debe reportarse como problema de
  // autorización: "403 Forbidden" ante lo que en realidad es un bug
  // manda a quien depure a mirar roles durante horas.
  it("un handler que lanza da 500, no 403", async () => {
    currentRole = "owner";
    const route = withRoute({ minRole: "viewer" }, async () => {
      throw new Error("boom");
    });

    const res = await route(request());

    expect(res.status).toBe(500);
  });
});

describe("withRoute — correo sin verificar (P0-SEC-08)", () => {
  it("un owner con el correo sin verificar no pasa", async () => {
    // El rol más alto, para que quede claro que el control no es de
    // rol: nadie opera sin haber probado que controla su dirección.
    currentRole = "owner";
    emailVerified = false;
    const route = withRoute({ minRole: "viewer" }, handler);

    const res = await route(request());

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("dice por qué, con un código que la UI puede leer", async () => {
    // Un 403 genérico manda a quien lo recibe a buscar un problema de
    // permisos que no tiene.
    emailVerified = false;
    const route = withRoute({ minRole: "viewer" }, handler);

    const body = (await (await route(request())).json()) as {
      error: string;
      code?: string;
    };

    expect(body.code).toBe("email_not_verified");
  });

  it("verificado, pasa con normalidad", async () => {
    // El contrapeso: sin esto la suite pasaría igual con un guard que
    // rechazara a todo el mundo.
    emailVerified = true;
    const route = withRoute({ minRole: "viewer" }, handler);

    expect((await route(request())).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
});
