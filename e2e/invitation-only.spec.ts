// ============================================================
// P0-SEC-08 — el alta es solo por invitación, de extremo a extremo.
//
// Antes de esto, un POST anónimo a /auth/v1/signup con la clave que
// viaja en el bundle devolvía un access token Y dejaba a quien
// llamara como `owner` de un inquilino nuevo. Medido, no supuesto.
//
// Cerrarlo tiene dos mitades que hay que probar juntas, porque cada
// una sin la otra es un fallo distinto:
//
//   - la puerta está cerrada          → nadie se registra solo
//   - y el invitado sigue entrando    → el producto no se rompe
//
// El primer caso ataca Supabase directamente, no la UI: el control
// vive ahí, y comprobarlo a través del formulario solo demostraría
// que el formulario no lo ofrece.
// ============================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";

import { ACCOUNTS, E2E_PASSWORD, userByKey } from "./support/fixtures";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Una invitación real en la base, como la que crearía un owner. */
async function createInvitation(role: "admin" | "agent" | "viewer" = "agent") {
  const token = randomBytes(32).toString("base64url");
  const db = admin();
  const { data: account } = await db
    .from("accounts")
    .select("id")
    .eq("name", ACCOUNTS.acme.name)
    .single();
  const owner = userByKey("acmeOwner");
  const { data: ownerRow } = await db
    .from("profiles")
    .select("user_id")
    .eq("full_name", owner.fullName)
    .single();

  const { error } = await db.from("account_invitations").insert({
    account_id: account!.id,
    token_hash: createHash("sha256").update(token).digest("hex"),
    role,
    created_by_user_id: ownerRow?.user_id ?? null,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  });
  if (error) throw new Error(`no se pudo crear la invitación: ${error.message}`);
  return { token, accountId: account!.id as string };
}

/** Borra el usuario de prueba y el inquilino personal que el trigger le crea. */
async function deleteUserByEmail(email: string) {
  const db = admin();
  const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const user = data?.users.find((u) => u.email === email);
  if (!user) return;
  await db.from("accounts").delete().eq("owner_user_id", user.id);
  await db.auth.admin.deleteUser(user.id);
}

test.describe("la puerta está cerrada", () => {
  test("Supabase rechaza un alta anónima", async ({ request }) => {
    // El ataque real, contra el sitio donde vive el control. La UI no
    // interviene: la clave anon está en el bundle de cualquiera.
    const res = await request.post(`${SUPABASE_URL}/auth/v1/signup`, {
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      data: { email: `intruso-${Date.now()}@ejemplo.test`, password: "unaClaveLarga123" },
      failOnStatusCode: false,
    });

    expect(res.status()).toBe(422);
    expect((await res.json()).error_code).toBe("signup_disabled");
  });

  test("/signup sin invitación no ofrece formulario", async ({ page }) => {
    await page.goto("/signup");

    await expect(page.getByRole("button", { name: /crear cuenta|create account/i })).toHaveCount(0);
    await expect(page.locator("#email")).toHaveCount(0);
  });

  test("un token inventado tampoco crea nada", async ({ request }) => {
    const email = `inventado-${Date.now()}@ejemplo.test`;
    const res = await request.post(`/api/invitations/no-existe-este-token/claim`, {
      data: { email, password: "unaClaveLarga123", fullName: "Nadie" },
      failOnStatusCode: false,
    });

    expect(res.status()).toBe(403);

    // Lo que importa no es el código, es que no haya cuenta detrás.
    const { data } = await admin().auth.admin.listUsers({ page: 1, perPage: 200 });
    expect(data?.users.some((u) => u.email === email)).toBe(false);
  });
});

test.describe("y el invitado sigue entrando", () => {
  test("de la invitación al inbox, sin alta pública", async ({ page }) => {
    const { token, accountId } = await createInvitation("agent");
    const email = `invitado-${Date.now()}@ejemplo.test`;

    try {
      // 1. El enlace de invitación lleva a un formulario real.
      await page.goto(`/signup?invite=${encodeURIComponent(token)}`);
      await page.locator("#fullName").fill("Invitada E2E");
      await page.locator("#email").fill(email);
      await page.locator("#password").fill(E2E_PASSWORD);
      await page.locator("#confirmPassword").fill(E2E_PASSWORD);
      await page.getByRole("button", { name: /crear cuenta|create account/i }).click();

      // 2. La cuenta existe, creada por el servidor y ya verificada.
      await expect(page.getByTestId("signup-go-to-login")).toBeVisible();

      // 3. Inicia sesión y acepta.
      await page.getByTestId("signup-go-to-login").click();
      await page.locator("#email").fill(email);
      await page.locator("#password").fill(E2E_PASSWORD);
      await page.getByRole("button", { name: /iniciar sesión|sign in/i }).click();

      await page.waitForURL(/\/join\//, { timeout: 15_000 });
      await page.getByRole("button", { name: /aceptar|accept/i }).click();

      // 4. Y acaba dentro, en la cuenta correcta y con el rol invitado.
      await page.waitForURL(/\/(dashboard|inbox)/, { timeout: 15_000 });

      const db = admin();
      const { data: users } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
      const created = users?.users.find((u) => u.email === email);
      expect(created, "el invitado debe existir").toBeTruthy();
      // Verificado al crearse: si no, el guard de getCurrentAccount lo
      // expulsaría en la primera petición.
      expect(created!.email_confirmed_at).toBeTruthy();

      const { data: profile } = await db
        .from("profiles")
        .select("account_id, account_role")
        .eq("user_id", created!.id)
        .single();
      expect(profile?.account_id).toBe(accountId);
      expect(profile?.account_role).toBe("agent");
    } finally {
      await deleteUserByEmail(email);
    }
  });
});
