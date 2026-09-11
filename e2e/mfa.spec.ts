// ============================================================
// P0-SEC-09 — segundo factor OPCIONAL, contra la app viva.
//
// Dos afirmaciones, y la primera es la que más importa desde que esto
// dejó de ser obligatorio:
//
//   sin activarlo, nadie queda fuera
//   activándolo, hay que usarlo
//
// La primera versión lo exigía a todo admin y owner. El día del
// despliegue eso dejó al owner del proyecto delante de un QR sin más
// salida que escanearlo, así que aquí se prueba explícitamente que ya
// no ocurre.
// ============================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { loginAs } from "./support/auth";
import { E2E_PASSWORD, userByKey } from "./support/fixtures";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Llama a la API desde la página, con sus cookies. */
async function callApi(page: Page, path: string, method = "GET"): Promise<{ status: number; code?: string }> {
  return page.evaluate(
    async ({ path, method }) => {
      const res = await fetch(path, { method });
      let code: string | undefined;
      try {
        code = ((await res.json()) as { code?: string }).code;
      } catch {
        /* respuesta sin cuerpo JSON */
      }
      return { status: res.status, code };
    },
    { path, method },
  );
}

/** Inicia sesión por la UI y se DETIENE en el reto, en aal1. */
async function signInWithoutSecondFactor(page: Page, userKey: string): Promise<void> {
  const user = userByKey(userKey);
  await page.goto("/login");
  await page.waitForFunction(() => {
    const form = document.querySelector("form");
    return !!form && Object.keys(form).some((k) => k.startsWith("__reactFiber$"));
  }, undefined, { timeout: 30_000 });
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/mfa/, { timeout: 30_000 });
}

test.describe("quien lo activó, tiene que usarlo", () => {
  test("un owner con factor activado y en aal1 no entra a configuración", async ({ page }) => {
    await signInWithoutSecondFactor(page, "acmeOwner");

    // El seed le inscribió un TOTP, así que esta sesión está a medias.
    // Sin esto, activar el segundo factor sería decorativo.
    const res = await callApi(page, "/api/whatsapp/config", "DELETE");

    expect(res.status).toBe(403);
    expect(res.code).toBe("mfa_challenge_required");
  });

  test("y con el reto superado, sí", async ({ page }) => {
    // El contrapeso. Sin esto la suite pasaría igual con un guard que
    // rechazara a todo administrador para siempre.
    await loginAs(page, "acmeOwner");

    const res = await callApi(page, "/api/whatsapp/config", "GET");

    expect(res.status).not.toBe(403);
  });

  test("una acción crítica pasa con autenticación reciente", async ({ page }) => {
    // `loginAs` acaba de verificar el TOTP, así que `amr` está fresco.
    // La denegación por antigüedad se prueba en unidad: en E2E
    // exigiría esperar cinco minutos de reloj real.
    await loginAs(page, "acmeOwner");

    const res = await callApi(page, "/api/export/full");

    expect(res.status).not.toBe(403);
    expect(res.code).not.toBe("reauth_required");
  });
});

test.describe("quien no lo activó, entra con normalidad", () => {
  test("un agent entra sin que le pidan nada", async ({ page }) => {
    // `loginAs` ya falla si un usuario sin factor acaba en /mfa.
    await loginAs(page, "acmeAgent");
    await page.goto("/inbox");

    await expect(page).not.toHaveURL(/\/mfa/);
    await expect(page.getByTestId("conversation-list")).toBeVisible({ timeout: 30_000 });
  });

  test("y puede seguir enviando, que es su trabajo", async ({ page }) => {
    await loginAs(page, "acmeAgent");
    await page.goto("/inbox");

    const res = await page.evaluate(async () => {
      const r = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: "x", message_type: "text", content: "hola" }),
      });
      return { status: r.status, body: await r.text() };
    });

    // El envío real falla porque WhatsApp no está configurado en el
    // entorno de pruebas; lo que se afirma es que NO lo para el
    // segundo factor.
    expect(res.status).not.toBe(403);
  });
});

test.describe("activarlo es un camino, no un muro", () => {
  test("desde Ajustes se llega al QR y a la clave manual", async ({ page }) => {
    // Antes se llegaba aquí a la fuerza, nada más iniciar sesión. Ahora
    // se llega queriendo, desde Ajustes → Acceso y seguridad.
    await loginAs(page, "acmeAgent");
    await page.goto("/settings?tab=security");

    await page.getByTestId("mfa-enable").click();
    await page.waitForURL(/\/mfa/, { timeout: 30_000 });

    await expect(page.getByAltText(/QR/i)).toBeVisible({ timeout: 30_000 });
    // Y una alternativa para quien no pueda escanear.
    await page.getByText(/no puedes escanear/i).click();
    await expect(page.getByTestId("mfa-secret")).toBeVisible();
  });

  test("y se puede salir sin activarlo", async ({ page }) => {
    // La salida que la primera versión no tenía: quien llegue aquí y
    // cambie de idea vuelve a su trabajo, no se queda delante del QR.
    await loginAs(page, "acmeAgent");
    await page.goto("/mfa?next=%2Finbox");

    await page.getByText(/ahora no/i).click();

    await page.waitForURL(/\/inbox/, { timeout: 30_000 });
    await expect(page).not.toHaveURL(/\/mfa/);
  });
});

test.describe("no se obliga a nadie a activarlo", () => {
  test("un owner SIN factor llega al dashboard y opera configuración", async ({ page }) => {
    // La regresión que este archivo existe para vigilar. Un usuario
    // nuevo, dueño de su cuenta y sin nada inscrito: exactamente quien
    // quedó atascado el día del despliegue.
    const email = `sin-mfa-${Date.now()}@ejemplo.test`;
    const db = admin();
    const { data: created, error } = await db.auth.admin.createUser({
      email,
      password: E2E_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Sin Segundo Factor" },
    });
    expect(error).toBeNull();

    try {
      await page.goto("/login");
      await page.waitForFunction(() => {
        const form = document.querySelector("form");
        return !!form && Object.keys(form).some((k) => k.startsWith("__reactFiber$"));
      }, undefined, { timeout: 30_000 });
      await page.locator("#email").fill(email);
      await page.locator("#password").fill(E2E_PASSWORD);
      await page.locator('button[type="submit"]').click();

      // Ni /mfa ni QR: directo a trabajar.
      await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
      await expect(page).not.toHaveURL(/\/mfa/);

      // Y la configuración responde, que es lo que antes devolvía 403.
      const res = await callApi(page, "/api/whatsapp/config", "GET");
      expect(res.status).not.toBe(403);
    } finally {
      const userId = created?.user?.id;
      if (userId) {
        await db.from("accounts").delete().eq("owner_user_id", userId);
        await db.auth.admin.deleteUser(userId);
      }
    }
  });

  test("y puede activarlo desde Ajustes si quiere", async ({ page }) => {
    await loginAs(page, "acmeAgent");
    await page.goto("/settings?tab=security");

    // El agent no tiene factor, así que la tarjeta ofrece activarlo.
    await expect(page.getByTestId("mfa-enable")).toBeVisible({ timeout: 30_000 });
  });
});
