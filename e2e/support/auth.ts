// Sign-in helper shared by every spec.
//
// It drives the real login form rather than injecting a session
// cookie. That costs a few seconds per test, and it is worth it: the
// bug class this suite exists to catch lives in the interaction
// between the auth cookie, the proxy that rotates it, and the client
// provider that reacts to it. A fabricated session would skip exactly
// the machinery under test.

import { expect, type Page } from "@playwright/test";

import { E2E_PASSWORD, userByKey, type SeedUser } from "./fixtures";
import { mfaSecretFor } from "./mfa-secrets";
import { msLeftInWindow, totpCode } from "./totp";

/**
 * Log in and wait until the app is genuinely usable.
 *
 * `waitForURL` alone is not enough — the dashboard shell renders a
 * loading state while `AuthProvider` resolves the session, and a spec
 * that starts clicking during that window races the provider.
 */
export async function loginAs(page: Page, userKey: string): Promise<SeedUser> {
  const user = userByKey(userKey);

  await page.goto("/login");

  // Wait for React to hydrate before touching the form.
  //
  // /login is server-rendered, so the inputs and the submit button
  // exist in the DOM well before any handler is attached to them.
  // Clicking during that window submits the form natively: the browser
  // performs a plain GET, reloads /login with the fields cleared and no
  // error banner, and the test sees what looks like a rejected
  // password. The tell is the URL — a native GET submit of a form with
  // no name attributes leaves a bare `?` on the end.
  //
  // Asserting that the fields hold their typed values is NOT a
  // sufficient guard: an un-hydrated input is uncontrolled, so the
  // value sticks perfectly while onSubmit is still absent. React tags
  // every DOM node it owns with a `__reactFiber$…` key, so look for
  // that on the form itself instead.
  await page.waitForFunction(
    () => {
      const form = document.querySelector("form");
      return !!form && Object.keys(form).some((k) => k.startsWith("__reactFiber$"));
    },
    undefined,
    { timeout: 30_000 },
  );

  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();

  // The proxy sends an authenticated user away from /login, so landing
  // anywhere outside it means the session cookie was accepted.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });

  // Segundo factor (P0-SEC-09).
  //
  // Quien administra la cuenta lleva TOTP inscrito por el seed, igual
  // que lo llevará en producción, así que la sesión aterriza en aal1 y
  // el shell la manda a /mfa. Se supera el reto por la página real —no
  // por la API— para que cada login de la suite ejercite el camino que
  // hace una persona.
  await completeMfaChallengeIfPresent(page, user);

  await expect(page.locator("text=Loading...")).toHaveCount(0, { timeout: 30_000 });

  return user;
}

/**
 * Si la navegación acabó en /mfa, teclea el código y continúa.
 *
 * Exportado porque hay specs que hacen su propio login —para probar el
 * viaje de `?next=`, por ejemplo— y también tienen que pasar por aquí:
 * los usuarios semilla de admin y owner llevan TOTP inscrito.
 *
 * No es incondicional: un agent o un viewer no tienen factor y nunca
 * pasan por aquí, que es precisamente lo que la aceptación pide
 * («un agent no se ve afectado»). Si alguna vez acabaran en /mfa, este
 * helper fallaría al no encontrar secreto — y sería el aviso correcto.
 */
export async function completeMfaChallengeIfPresent(page: Page, user: SeedUser): Promise<void> {
  const secret = mfaSecretFor(user.email);

  // Sin factor inscrito no hay reto que superar, y tampoco debe
  // haberlo: si un agent acabara en /mfa, esto lo dejaría pasar y el
  // fallo aparecería más adelante y más lejos. Por eso se comprueba.
  if (!secret) {
    await expect(page).not.toHaveURL(/\/mfa/);
    return;
  }

  // Se ESPERA a /mfa en vez de mirar la URL de golpe.
  //
  // El redirect lo decide el navegador después de leer el nivel de la
  // sesión, así que en el instante en que termina el login la URL
  // todavía es la del destino. Mirarla entonces daba un falso "no hace
  // falta reto": la sesión se quedaba en aal1 y el rebote aparecía en
  // la siguiente navegación, lejos de la causa.
  //
  // Esperarlo es además la afirmación que pide la aceptación: a quien
  // administra la cuenta se le dirige al segundo factor.
  await page.waitForURL(/\/mfa/, { timeout: 30_000 });
  await page.waitForSelector('[data-testid="mfa-code"]', { timeout: 30_000 });

  // Un código a punto de caducar puede cambiar de intervalo entre que
  // se teclea y que el servidor lo comprueba: fallaría una vez de cada
  // treinta, que es la peor clase de test intermitente.
  if (msLeftInWindow() < 3_000) {
    await page.waitForTimeout(msLeftInWindow() + 250);
  }

  await page.locator('[data-testid="mfa-code"]').fill(totpCode(secret));
  await page.locator('[data-testid="mfa-submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/mfa"), { timeout: 30_000 });
}

/**
 * Clear browser-side auth state. Used by the tenant-isolation spec,
 * which switches accounts inside one browser context and must prove
 * nothing survives the switch.
 */
export async function logout(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.evaluate(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // Storage can throw in restricted contexts; cookies are the
      // part that actually carries the session.
    }
  });
}
