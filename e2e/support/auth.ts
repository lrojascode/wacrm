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
  await expect(page.locator("text=Loading...")).toHaveCount(0, { timeout: 30_000 });

  return user;
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
