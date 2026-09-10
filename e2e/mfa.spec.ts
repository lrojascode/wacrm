// ============================================================
// P0-SEC-09 — segundo factor y reautenticación, contra la app viva.
//
// Los tests unitarios prueban que las decisiones son correctas. Esto
// prueba que se aplican: sesiones reales, cookies reales, handlers
// reales. La diferencia importa porque el control se deriva del
// `minRole` de cada ruta, y un error ahí no se ve en la unidad — se ve
// cuando una ruta de configuración deja pasar una sesión de aal1.
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

test.describe("a quien administra se le exige el segundo factor", () => {
  test("un owner en aal1 no entra a una ruta de configuración", async ({ page }) => {
    await signInWithoutSecondFactor(page, "acmeOwner");

    // Sesión válida, rol de sobra, y aun así no pasa: le falta el
    // factor. El código distingue "mete el código" de "inscríbete",
    // porque mandar a inscribirse a quien ya tiene factor es un
    // callejón sin salida.
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

test.describe("a quien solo opera, no", () => {
  test("un agent entra sin que le pidan nada", async ({ page }) => {
    // «Un agent no se ve afectado», comprobado de extremo a extremo.
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

test.describe("inscripción", () => {
  test("un owner sin factor ve el código QR, no un muro", async ({ page }) => {
    // Un usuario nuevo, dueño de su propia cuenta y sin nada inscrito:
    // exactamente quien encontrará esto el día del despliegue.
    const email = `mfa-nuevo-${Date.now()}@ejemplo.test`;
    const db = admin();
    const { data: created, error } = await db.auth.admin.createUser({
      email,
      password: E2E_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Sin Factor" },
    });
    expect(error, "el usuario de prueba debe crearse").toBeNull();

    try {
      await page.goto("/login");
      await page.waitForFunction(() => {
        const form = document.querySelector("form");
        return !!form && Object.keys(form).some((k) => k.startsWith("__reactFiber$"));
      }, undefined, { timeout: 30_000 });
      await page.locator("#email").fill(email);
      await page.locator("#password").fill(E2E_PASSWORD);
      await page.locator('button[type="submit"]').click();

      // Dirigido a inscripción, que es lo que pide la aceptación —
      // no bloqueado con un mensaje sin salida.
      await page.waitForURL(/\/mfa/, { timeout: 30_000 });
      await expect(page.getByAltText(/QR/i)).toBeVisible({ timeout: 30_000 });
      // Y una alternativa para quien no pueda escanear.
      await page.getByText(/no puedes escanear/i).click();
      await expect(page.getByTestId("mfa-secret")).toBeVisible();
    } finally {
      const userId = created?.user?.id;
      if (userId) {
        await db.from("accounts").delete().eq("owner_user_id", userId);
        await db.auth.admin.deleteUser(userId);
      }
    }
  });
});
