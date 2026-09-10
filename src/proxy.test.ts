import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the proxy returns — including redirects.
// `email_confirmed_at` entra en el tipo con P0-SEC-08: el proxy
// redirige a /login?verify=1 a quien tiene sesión pero no ha
// verificado su correo, así que un usuario de prueba sin el campo ya
// no representa a alguien que pueda navegar.
type MockUser = { id: string; email_confirmed_at?: string | null };
let mockUser: MockUser | null = null;
/** Un usuario normal: con sesión y con el correo verificado. */
const verifiedUser = (): MockUser => ({
  id: "user-1",
  email_confirmed_at: "2026-01-01T00:00:00Z",
});
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
    },
  }),
}));

// Imported after the mock is registered.
const { proxy } = await import("./proxy");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  refreshedCookies = [];
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("proxy — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = verifiedUser();
    refreshedCookies = [ROTATED];

    const res = await proxy(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await proxy(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = verifiedUser();
    refreshedCookies = [ROTATED];

    const res = await proxy(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = verifiedUser();
    refreshedCookies = [ROTATED];

    const res = await proxy(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

// ============================================================
// P0-BUG-03 — `?next=` round trip.
//
// The rule that sends a signed-in user away from /login used to wipe
// the query string and deposit them on /dashboard. That is the second
// half of the reported bug: after a transient auth blip the cookie was
// often still valid, so this branch fired and the user "ended up back
// at the start" with nothing to indicate a sign-out had happened.
// ============================================================

describe("proxy — ?next= al volver de /login", () => {
  it("devuelve al usuario a la ruta pedida en vez de a /dashboard", async () => {
    mockUser = verifiedUser();

    const res = await proxy(
      new NextRequest("https://app.test/login?next=%2Finbox%3Fc%3Dabc-123"),
    );

    const location = res.headers.get("location")!;
    expect(location).toContain("/inbox");
    expect(location).toContain("c=abc-123");
    expect(location).not.toContain("/dashboard");
  });

  it("cae a /dashboard cuando no hay next", async () => {
    mockUser = verifiedUser();

    const res = await proxy(new NextRequest("https://app.test/login"));

    expect(res.headers.get("location")).toContain("/dashboard");
  });

  // Un `next` es controlable por quien envíe el enlace, así que esta es
  // la prueba que impide convertir el login en un open redirect.
  it.each([
    ["absoluto", "https%3A%2F%2Fevil.example%2Fx"],
    ["relativo al protocolo", "%2F%2Fevil.example"],
    ["barra invertida", "%2F%5Cevil.example"],
    ["javascript:", "javascript%3Aalert(1)"],
  ])("ignora un next externo (%s) y usa /dashboard", async (_label, encoded) => {
    mockUser = verifiedUser();

    const res = await proxy(
      new NextRequest(`https://app.test/login?next=${encoded}`),
    );

    const location = res.headers.get("location")!;
    expect(location).toContain("/dashboard");
    expect(location).not.toContain("evil.example");
    // El destino tiene que seguir siendo del mismo origen.
    expect(new URL(location).origin).toBe("https://app.test");
  });

  it("una invitación tiene prioridad sobre next", async () => {
    mockUser = verifiedUser();

    const res = await proxy(
      new NextRequest("https://app.test/login?invite=abc123&next=%2Finbox"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
  });

  it("al expulsar a un anónimo de una ruta protegida, guarda el destino", async () => {
    mockUser = null;

    const res = await proxy(new NextRequest("https://app.test/inbox/abc-123"));

    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    // El query original no debe quedar colgando en /login: antes una
    // petición a /inbox?c=<id> se convertía en /login?c=<id>.
    expect(location.searchParams.get("c")).toBeNull();
    expect(location.searchParams.get("next")).toBe("/inbox/abc-123");
  });

  it("un anónimo con enlace antiguo se normaliza primero y luego va a /login", async () => {
    mockUser = null;

    // La normalización corre antes del control de auth, así que el
    // anónimo da dos saltos: /inbox?c=<id> -> /inbox/<id> -> /login.
    // Es deliberado: el `next` que acaba guardándose es la URL
    // canónica, no la heredada.
    const first = await proxy(new NextRequest("https://app.test/inbox?c=abc-123"));
    expect(first.status).toBe(308);
    expect(new URL(first.headers.get("location")!).pathname).toBe("/inbox/abc-123");

    const second = await proxy(new NextRequest("https://app.test/inbox/abc-123"));
    expect(
      new URL(second.headers.get("location")!).searchParams.get("next"),
    ).toBe("/inbox/abc-123");
  });
});

describe("proxy — enlaces antiguos /inbox?c=<id>", () => {
  it("redirige 308 a /inbox/<id> sin arrastrar el query", async () => {
    mockUser = verifiedUser();

    const res = await proxy(
      new NextRequest("https://app.test/inbox?c=abc-123"),
    );

    expect(res.status).toBe(308);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/inbox/abc-123");
    // `redirects()` en next.config dejaba el parámetro consumido pegado
    // al destino (/inbox/abc-123?c=abc-123). Por eso la regla vive aquí.
    expect(location.search).toBe("");
  });

  it("no redirige cuando c está vacío", async () => {
    mockUser = verifiedUser();

    const res = await proxy(new NextRequest("https://app.test/inbox?c="));

    expect(res.headers.get("location")).toBeNull();
  });

  it("deja pasar /inbox sin parámetros", async () => {
    mockUser = verifiedUser();

    const res = await proxy(new NextRequest("https://app.test/inbox"));

    expect(res.headers.get("location")).toBeNull();
  });
});

describe("proxy — correo sin verificar (P0-SEC-08)", () => {
  it("manda a /login?verify=1 desde una página protegida", async () => {
    mockUser = { id: "user-1", email_confirmed_at: null };

    const res = await proxy(new NextRequest("https://app.test/inbox"));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    // El parámetro es lo que hace que /login explique por qué está
    // ahí, en vez de parecer un cierre de sesión sin motivo.
    expect(location.searchParams.get("verify")).toBe("1");
  });

  it("no molesta a quien sí lo tiene verificado", async () => {
    mockUser = verifiedUser();

    const res = await proxy(new NextRequest("https://app.test/inbox"));

    expect(res.headers.get("location")).toBeNull();
  });

  it("deja /login accesible para no encerrar a nadie en un bucle", async () => {
    // Si el propio destino del redirect estuviera protegido, la
    // persona rebotaría para siempre.
    mockUser = { id: "user-1", email_confirmed_at: null };

    const res = await proxy(new NextRequest("https://app.test/login?verify=1"));

    const location = res.headers.get("location");
    expect(location === null || !location.includes("verify=1&verify=1")).toBe(true);
  });
});
