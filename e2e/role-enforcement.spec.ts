// ============================================================
// P0-SEC-02 — the role ladder, against the running app.
//
// The unit tests prove `withRoute` computes the right answer. This
// proves the routes actually go through it: a real `viewer` session,
// real cookies, real handlers. The gap being closed was not a wrong
// answer — it was ten routes that never asked the question.
//
// Requests go out with `fetch` from an authenticated page rather than
// through the UI, because the UI already hides these actions from a
// viewer. Hiding a button is not authorisation; the point is what
// happens when someone calls the endpoint anyway.
// ============================================================

import { expect, test, type Page } from "@playwright/test";

import { loginAs } from "./support/auth";
import { conversationsFor } from "./support/fixtures";

const [conversation] = conversationsFor("acme");

/** Call an endpoint from inside the authenticated page context. */
async function callApi(
  page: Page,
  path: string,
  init: { method: string; body?: unknown },
): Promise<number> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.status;
    },
    { path, method: init.method, body: init.body ?? null },
  );
}

test.describe("autorización por rol · un viewer no opera", () => {
  // One login for the whole file: these are all read-only assertions
  // about rejection, so they cannot interfere with each other.
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "acmeViewer");
    await page.goto("/inbox");
  });

  test("no puede enviar un mensaje de WhatsApp", async ({ page }) => {
    const status = await callApi(page, "/api/whatsapp/send", {
      method: "POST",
      body: {
        conversation_id: conversation.id,
        message_type: "text",
        content: "esto no debería salir",
      },
    });

    expect(status).toBe(403);
  });

  test("no puede reaccionar a un mensaje", async ({ page }) => {
    const status = await callApi(page, "/api/whatsapp/react", {
      method: "POST",
      body: { message_id: "m1", emoji: "👍" },
    });

    expect(status).toBe(403);
  });

  test("no puede lanzar un broadcast", async ({ page }) => {
    const status = await callApi(page, "/api/whatsapp/broadcast", {
      method: "POST",
      body: { name: "x", template_name: "y", recipients: [] },
    });

    expect(status).toBe(403);
  });

  test("no puede enviar una plantilla a Meta", async ({ page }) => {
    // Esta es además la ruta que alcanza el SSRF de P0-SEC-04, así que
    // el rol es de momento lo único que la separa de un viewer.
    const status = await callApi(page, "/api/whatsapp/templates/submit", {
      method: "POST",
      body: { name: "x", language: "es", category: "MARKETING", body_text: "hola" },
    });

    expect(status).toBe(403);
  });

  test("no puede sincronizar plantillas", async ({ page }) => {
    expect(await callApi(page, "/api/whatsapp/templates/sync", { method: "POST" })).toBe(403);
  });

  test("no puede leer flows ni sus ejecuciones", async ({ page }) => {
    expect(await callApi(page, "/api/flows/templates", { method: "GET" })).toBe(403);
  });

  test("no puede tocar la configuración de WhatsApp", async ({ page }) => {
    // Owner-only: aquí vive el token.
    expect(await callApi(page, "/api/whatsapp/config", { method: "DELETE" })).toBe(403);
    expect(
      await callApi(page, "/api/whatsapp/config/verify-registration", { method: "GET" }),
    ).toBe(403);
  });

  // El contrapeso: un viewer SÍ debe poder leer. Sin esto, la suite
  // pasaría igual si el guard rechazara a todo el mundo.
  test("sí puede leer el proxy de media, que es lectura del inbox", async ({ page }) => {
    const status = await callApi(page, "/api/whatsapp/media/no-existe", { method: "GET" });

    // No 403: el rol le alcanza. Lo que devuelva depende de que el id
    // exista, y no existe — lo que importa es que no sea un rechazo por
    // autorización.
    expect(status).not.toBe(403);
    expect(status).not.toBe(401);
  });
});

test.describe("autorización por rol · un agent sí opera", () => {
  // La otra mitad del contrapeso: el arreglo no debe haber roto a quien
  // sí tiene permiso.
  test("un agent no recibe 403 al enviar", async ({ page }) => {
    await loginAs(page, "acmeAgent");
    await page.goto("/inbox");

    const status = await callApi(page, "/api/whatsapp/send", {
      method: "POST",
      body: {
        conversation_id: conversation.id,
        message_type: "text",
        content: "hola",
      },
    });

    // El envío real falla porque WhatsApp no está configurado en el
    // entorno de pruebas; lo que se afirma es que NO lo para el rol.
    expect(status).not.toBe(403);
  });
});
