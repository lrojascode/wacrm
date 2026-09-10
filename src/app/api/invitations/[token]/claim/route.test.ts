// ============================================================
// P0-SEC-08 — the invitation-gated account creation route.
//
// This is the last remaining way to create a user without an admin
// doing it by hand, so what matters is the boundary: a valid,
// unexpired, unused invitation creates exactly one account, and
// everything else creates nothing at all.
//
// The assertion is always "did createUser run", not just the status
// code. A route that returned 403 and still created the user would
// pass a status-only test and be the exact bug worth catching.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What `peek_invitation` should answer for the next call. */
let peekResult: unknown = { ok: true, account_name: "Acme", role: "agent" };
let peekError: unknown = null;

/** What the admin API should answer. */
let createError: { message: string } | null = null;

const createUser = vi.fn(async () => ({
  data: createError ? { user: null } : { user: { id: "new-user" } },
  error: createError,
}));

const rpc = vi.fn(async () => ({ data: peekResult, error: peekError }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ auth: { admin: { createUser } } }),
}));

const { POST } = await import("./route");

/**
 * Un token distinto por llamada.
 *
 * El primer intento reusaba uno solo y la mitad de los tests
 * devolvieron 429: el límite POR TOKEN —5/min, justo el que impide
 * que quien tenga un enlace válido acuñe cuentas en serie— hacía su
 * trabajo contra la propia suite. Aislar cada caso es lo correcto;
 * que el límite exista se prueba aparte, abajo.
 */
let tokenSeq = 0;
const nextToken = () => `token-de-prueba-${++tokenSeq}`;

function call(body: unknown, token: string = nextToken()) {
  return POST(
    new Request("https://app.test/api/invitations/x/claim", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Rate limiting is per-IP; a distinct IP per test keeps them
        // independent of each other's budget.
        "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  );
}

const VALID = {
  email: "nuevo@ejemplo.test",
  password: "unaClaveLarga123",
  fullName: "Nuevo Miembro",
};

beforeEach(() => {
  createUser.mockClear();
  rpc.mockClear();
  peekResult = { ok: true, account_name: "Acme", role: "agent" };
  peekError = null;
  createError = null;
});

describe("con una invitación válida", () => {
  it("crea la cuenta con el correo ya verificado", async () => {
    const res = await call(VALID);

    expect(res.status).toBe(201);
    expect(createUser).toHaveBeenCalledOnce();
    // `email_confirm: true` es lo que hace que el invitado satisfaga
    // el guard de correo verificado de getCurrentAccount. Sin esto
    // entraría y sería expulsado en la primera petición.
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: VALID.email,
        email_confirm: true,
        user_metadata: { full_name: VALID.fullName },
      }),
    );
  });

  it("valida la invitación ANTES de crear nada", async () => {
    await call(VALID);
    // El orden es el control: comprobar después de crear dejaría la
    // cuenta hecha aunque la invitación no valiera.
    expect(rpc).toHaveBeenCalledWith(
      "peek_invitation",
      expect.objectContaining({ p_token_hash: expect.any(String) }),
    );
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(
      createUser.mock.invocationCallOrder[0],
    );
  });

  it("nunca manda el token en claro a la base", async () => {
    await call(VALID);
    const sent = (rpc.mock.calls[0] as unknown as [string, { p_token_hash: string }])[1];
    expect(sent.p_token_hash).not.toMatch(/^token-de-prueba-/);
    expect(sent.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sin una invitación utilizable no se crea nada", () => {
  for (const reason of ["not_found", "used", "expired"]) {
    it(`rechaza una invitación "${reason}"`, async () => {
      peekResult = { ok: false, reason };

      const res = await call(VALID);

      expect(res.status).toBe(403);
      expect(createUser).not.toHaveBeenCalled();
    });
  }

  it("da el mismo mensaje para todos los motivos", async () => {
    // Distinguirlos confirmaría a quien adivina que un token existe,
    // que es justo lo que 256 bits de entropía deben ocultar.
    const mensajes = new Set<string>();
    for (const reason of ["not_found", "used", "expired"]) {
      peekResult = { ok: false, reason };
      const body = (await (await call(VALID)).json()) as { error: string };
      mensajes.add(body.error);
    }
    expect(mensajes.size).toBe(1);
  });

  it("un fallo de la RPC no crea la cuenta", async () => {
    peekError = { message: "boom" };

    const res = await call(VALID);

    expect(res.status).toBe(500);
    expect(createUser).not.toHaveBeenCalled();
  });
});

describe("validación de la entrada", () => {
  it("exige un correo con forma de correo", async () => {
    const res = await call({ ...VALID, email: "no-es-un-correo" });
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("exige una contraseña de al menos 8 caracteres", async () => {
    const res = await call({ ...VALID, password: "corta1" });
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("rechaza un cuerpo que no es JSON válido", async () => {
    const res = await POST(
      new Request("https://app.test/api/invitations/x/claim", {
        method: "POST",
        headers: { "x-forwarded-for": "10.9.9.9" },
        body: "{no es json",
      }),
      { params: Promise.resolve({ token: nextToken() }) },
    );
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("rechaza un token vacío sin consultar nada", async () => {
    const res = await call(VALID, "");
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });
});

describe("correo ya registrado", () => {
  it("devuelve 409 y dice qué hacer", async () => {
    createError = { message: "A user with this email address has already been registered" };

    const res = await call(VALID);
    const body = (await res.json()) as { error: string; code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("email_exists");
    // Este sí se distingue a propósito: no es un secreto que el
    // correo propio ya tenga cuenta, y sin decirlo la persona se queda
    // sin saber que lo suyo es iniciar sesión.
    expect(body.error).toMatch(/sign in/i);
  });
});

describe("límite por token", () => {
  it("corta la acuñación en serie con un mismo enlace", async () => {
    // Una invitación no está atada a un correo: quien tiene el enlace
    // elige la dirección. Solo una de las cuentas podrá canjear el
    // token, pero sin este límite el resto quedarían igualmente como
    // cuentas personales huérfanas.
    const mismoToken = nextToken();
    const codigos: number[] = [];
    for (let i = 0; i < 8; i++) {
      codigos.push((await call(VALID, mismoToken)).status);
    }

    expect(codigos.filter((c) => c === 201).length).toBeLessThanOrEqual(5);
    expect(codigos).toContain(429);
  });
});
