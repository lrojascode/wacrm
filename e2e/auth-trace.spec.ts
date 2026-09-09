// ============================================================
// P0-BUG-01 — what actually happens on a return to the tab?
//
// The spec called for 24 hours of staging telemetry to answer this.
// With the E2E harness in place the same question can be answered
// deterministically in seconds, which is both faster and far better
// evidence: a reproduction can be re-run against a fix, a log sample
// cannot.
//
// Two things are being measured, and they are independent:
//
//   1. Does auth-js emit an auth event on every visibilitychange →
//      visible? This is the premise of the whole root-cause chain. If
//      it does not, the analysis is wrong and the fix would be aimed at
//      the wrong place.
//
//   2. What a genuine loss of session looks like in the trace, as the
//      contrast that makes a *spurious* expulsion recognisable. A real
//      one carries `cookie=NO`; the reported bug is the case that
//      carries `cookie=sí`, because the proxy then bounces the
//      resulting /login visit back to /dashboard.
//
// These specs report their findings rather than only asserting them:
// the point of the task is the measurement.
// ============================================================

import { expect, test, type Page } from "@playwright/test";

import { loginAs } from "./support/auth";
import { conversationsFor } from "./support/fixtures";

const [firstConversation] = conversationsFor("acme");

interface TraceEntry {
  kind: string;
  label: string;
  t: number;
  visibility: string;
  path: string;
  hasAuthCookie: boolean;
  hasSession?: boolean;
}

async function readTrace(page: Page): Promise<TraceEntry[]> {
  return page.evaluate(() => {
    const fn = (window as unknown as Record<string, unknown>).__authTrace;
    return typeof fn === "function" ? (fn as () => TraceEntry[])() : [];
  });
}

/**
 * Drive a hidden → visible cycle.
 *
 * `Emulation.setPageVisibilityOverride` is not available in the bundled
 * Chromium, so override the getter and dispatch the event by hand. That
 * is exactly what the listeners under test read: auth-js checks
 * `document.visibilityState` inside its own `visibilitychange` handler
 * (GoTrueClient `_onVisibilityChanged`), and so does the inbox.
 */
async function cycleVisibility(page: Page): Promise<void> {
  const setVisibility = (state: "hidden" | "visible") =>
    page.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => value,
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => value === "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);

  await setVisibility("hidden");
  await page.waitForTimeout(1_000);
  await setVisibility("visible");
  await page.waitForTimeout(3_000);
}

function summarise(trace: TraceEntry[]): string {
  return trace
    .map(
      (e) =>
        `  ${String(e.t).padStart(7)}ms  ${e.kind.padEnd(11)} ${e.label.padEnd(18)} ` +
        `vis=${e.visibility.padEnd(7)} cookie=${e.hasAuthCookie ? "sí " : "NO "} ` +
        `session=${e.hasSession === undefined ? "-" : e.hasSession ? "sí" : "NO"}  ${e.path}`,
    )
    .join("\n");
}

test.describe("P0-BUG-01 · diagnóstico de transiciones de auth", () => {
  // Chromium only. The question is about auth-js behaviour, which is
  // not browser-specific, so running it twice would only double the
  // cost. The cross-browser coverage that matters is in the P0-BUG
  // suite, which exercises the inbox itself.
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "el comportamiento medido no depende del navegador",
  );

  test("¿qué evento de auth sigue a un retorno de pestaña?", async ({ page }) => {
    await loginAs(page, "acmeOwner");
    await page.goto("/inbox");
    await page
      .getByTestId("conversation-list")
      .getByText(firstConversation.contactName)
      .click();
    await expect(
      page.getByTestId("message-thread").getByText(firstConversation.firstMessage),
    ).toBeVisible();

    const trace = await readTrace(page);
    test.skip(
      trace.length === 0,
      "NEXT_PUBLIC_AUTH_TRACE no está activo — el servidor de dev se reutilizó sin el flag",
    );

    await page.evaluate(() => {
      const clear = (window as unknown as Record<string, unknown>).__authTraceClear;
      if (typeof clear === "function") (clear as () => void)();
    });

    await cycleVisibility(page);

    const after = await readTrace(page);
    const authEvents = after.filter((e) => e.kind === "auth-event");
    const expulsions = after.filter((e) => e.kind === "expulsion");

    console.log(
      "\n=== P0-BUG-01 · retorno de pestaña ===\n" +
        summarise(after) +
        `\n\n  eventos de auth tras volver: ${authEvents.length}` +
        ` (${authEvents.map((e) => e.label).join(", ") || "ninguno"})` +
        `\n  expulsiones: ${expulsions.length}\n`,
    );

    // The behaviour under test: returning to the tab must not throw the
    // user out. This is the reported bug in its mildest reproducible
    // form, and it is what P0-BUG-02/03 have to keep green.
    expect(expulsions).toHaveLength(0);
    await expect(page).toHaveURL(/\/inbox/);
    await expect(
      page.getByTestId("message-thread").getByText(firstConversation.firstMessage),
    ).toBeVisible();
  });

  test("reproducción: refresh no reintentable expulsa al usuario", async ({
    page,
    context,
  }) => {
    await loginAs(page, "acmeOwner");
    await page.goto("/inbox");
    await page
      .getByTestId("conversation-list")
      .getByText(firstConversation.contactName)
      .click();
    await expect(
      page.getByTestId("message-thread").getByText(firstConversation.firstMessage),
    ).toBeVisible();

    const before = await readTrace(page);
    test.skip(
      before.length === 0,
      "NEXT_PUBLIC_AUTH_TRACE no está activo — el servidor de dev se reutilizó sin el flag",
    );

    // Recreates the one condition that actually expels a user, found by
    // elimination: neither a plain tab return nor a cleared cookie nor
    // a *network* failure on refresh does it — auth-js deliberately
    // preserves the session on retryable errors. What does it is an
    // expired access token plus a refresh the server rejects
    // definitively, which is the rotation race between auth-js and the
    // proxy (both call getUser/refresh and rotate the same token).
    //
    // Forging the expiry inside the cookie is how the "hours in a
    // background tab" precondition is reached without waiting hours.
    const cookies = await context.cookies();
    const authCookie = cookies.find((c) => c.name.includes("auth-token"));
    if (!authCookie) throw new Error("no hay cookie de sesión");

    const raw = decodeURIComponent(authCookie.value);
    const payload = raw.startsWith("base64-") ? raw.slice("base64-".length) : raw;
    const session = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    session.expires_at = Math.floor(Date.now() / 1000) - 3600;
    session.expires_in = 0;
    await context.addCookies([
      {
        ...authCookie,
        value: encodeURIComponent(
          "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64"),
        ),
      },
    ]);

    await page.route("**/auth/v1/token*", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          code: 400,
          error_code: "refresh_token_not_found",
          msg: "Invalid Refresh Token: Refresh Token Not Found",
        }),
      });
    });

    await page.evaluate(() => {
      const clear = (window as unknown as Record<string, unknown>).__authTraceClear;
      if (typeof clear === "function") (clear as () => void)();
    });

    await cycleVisibility(page);
    await page.waitForTimeout(3_000);

    const after = await readTrace(page);
    const expulsions = after.filter((e) => e.kind === "expulsion");
    const signedOut = after.filter(
      (e) => e.kind === "auth-event" && e.hasSession === false,
    );

    console.log(
      "\n=== P0-BUG-01 · reproducción de la expulsión ===\n" +
        summarise(after) +
        `\n\n  eventos de auth sin sesión: ${signedOut.map((e) => e.label).join(", ") || "ninguno"}` +
        `\n  expulsiones: ${expulsions.length}` +
        `\n  URL final: ${page.url()}\n`,
    );

    // Documents today's behaviour so the fix has something to change.
    // P0-BUG-03 must make this stop expelling on a *transient* failure;
    // when it does, this assertion is the one that has to be inverted,
    // deliberately and with the reason recorded.
    expect(expulsions.length, "hoy una sesión perdida expulsa al usuario").toBeGreaterThan(0);
    await expect(page).not.toHaveURL(/\/inbox/);
  });
});
