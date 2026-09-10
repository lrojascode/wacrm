// ============================================================
// P0-SEC-10 — la Content-Security-Policy, contra rutas reales.
//
// La cabecera llevaba tiempo en `Report-Only`, que es la forma correcta
// de empezar y una forma malísima de terminar: no bloquea nada, así
// que su único valor está en que alguien mire los informes. Nadie los
// miraba.
//
// Esto los mira. Se registra un oyente de `securitypolicyviolation`
// —el evento que dispara el navegador, tanto en report-only como en
// modo bloqueo— antes de navegar, y se recorren las pantallas que la
// aceptación nombra: inbox con media, realtime y gráficos.
//
// Se afirma CERO violaciones. Es lo que convierte la política en algo
// que se puede activar sin romper la app, y lo que impide que vuelva a
// pudrirse: quien añada mañana un script de un tercero verá fallar
// esto en vez de descubrirlo en producción.
//
// POR QUÉ IMPORTA CORRERLO EN PRODUCCIÓN (E2E_PROD=1)
//
// En desarrollo React usa `eval` para reconstruir stacks de error, y
// el overlay de Next inyecta lo suyo. La política de producción no
// concede `unsafe-eval`, así que una pasada en dev no puede confirmar
// que sobra. La suite corre igual en los dos modos —siempre comprueba
// connect-src, img-src, frame-ancestors…— pero la afirmación fuerte
// sobre scripts solo es válida contra el artefacto real.
// ============================================================

import { expect, test, type Page } from "@playwright/test";

import { loginAs } from "./support/auth";
import { conversationsFor } from "./support/fixtures";

interface Violation {
  directive: string;
  blockedURI: string;
  source: string;
}

/**
 * Empieza a recoger violaciones en esta página.
 *
 * `addInitScript` se ejecuta antes que cualquier script del documento,
 * en cada navegación, así que no se pierden las violaciones que ocurren
 * durante la carga inicial — que son justo las que importan.
 */
async function collectViolations(page: Page): Promise<() => Promise<Violation[]>> {
  await page.addInitScript(() => {
    const store: Violation[] = [];
    (window as unknown as { __csp: Violation[] }).__csp = store;
    document.addEventListener("securitypolicyviolation", (e) => {
      store.push({
        directive: e.effectiveDirective || e.violatedDirective,
        blockedURI: e.blockedURI,
        source: `${e.sourceFile ?? "?"}:${e.lineNumber ?? 0}`,
      });
    });
  });

  return async () => {
    try {
      return await page.evaluate(
        () => (window as unknown as { __csp?: Violation[] }).__csp ?? [],
      );
    } catch {
      return [];
    }
  };
}

function describeViolations(where: string, violations: Violation[]): string {
  return (
    `${violations.length} violación(es) de CSP en ${where}:\n\n` +
    violations
      .map((v) => `  ${v.directive}\n    bloqueado: ${v.blockedURI}\n    origen:    ${v.source}`)
      .join("\n") +
    `\n\nO la política de next.config.ts necesita este origen, o algo se coló ` +
    `que no debería estar ahí. Decide cuál antes de ampliarla.\n`
  );
}

test.describe("CSP · las pantallas reales no la violan", () => {
  test("la cabecera va en modo bloqueo, no solo informe", async ({ request }) => {
    // La afirmación central de la tarea. Con `Report-Only` la política
    // no protege de nada; solo describe.
    const res = await request.get("/login");

    expect(res.headers()["content-security-policy"]).toBeTruthy();
    expect(res.headers()["content-security-policy-report-only"]).toBeUndefined();
  });

  test("login y alta, sin sesión", async ({ page }) => {
    const read = await collectViolations(page);

    await page.goto("/login");
    await expect(page.locator("#email")).toBeVisible();
    await page.goto("/signup");
    await page.waitForLoadState("networkidle");

    const violations = await read();
    expect(violations, describeViolations("/login y /signup", violations)).toEqual([]);
  });

  test("inbox con una conversación abierta y su media", async ({ page }) => {
    const read = await collectViolations(page);
    const [conversation] = conversationsFor("acme");

    await loginAs(page, "acmeOwner");
    await page.goto(`/inbox/${conversation.id}`);
    await expect(page.getByTestId("message-thread")).toBeVisible({ timeout: 30_000 });
    // Realtime: la suscripción por WSS a Supabase es lo que pone a
    // prueba `connect-src`, y solo se abre con el inbox montado.
    await page.waitForTimeout(1500);

    const violations = await read();
    expect(violations, describeViolations("/inbox", violations)).toEqual([]);
  });

  test("dashboard con gráficos", async ({ page }) => {
    // Recharts dibuja con SVG y estilos en línea: es el consumidor más
    // exigente de `style-src` de toda la app.
    const read = await collectViolations(page);

    await loginAs(page, "acmeOwner");
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    const violations = await read();
    expect(violations, describeViolations("/dashboard", violations)).toEqual([]);
  });

  test("ajustes, que es donde vive la configuración", async ({ page }) => {
    const read = await collectViolations(page);

    await loginAs(page, "acmeOwner");
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const violations = await read();
    expect(violations, describeViolations("/settings", violations)).toEqual([]);
  });
});
