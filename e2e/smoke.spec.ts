// Smoke test — proves the E2E harness itself works end to end:
// the seed produced usable data, a seeded user can sign in through the
// real form, the proxy lets them through, and the inbox renders a
// seeded conversation.
//
// Deliberately shallow. The inbox navigation behaviour (tab switching,
// history, deep links, tenant isolation) is the subject of its own
// suite under P0-BUG; if those specs fail, this one failing too tells
// you the problem is the harness rather than the app.

import { expect, test } from "@playwright/test";

import { loginAs } from "./support/auth";
import { conversationsFor } from "./support/fixtures";

const [firstConversation] = conversationsFor("acme");

test.describe("smoke", () => {
  test("unauthenticated visitor is sent to login", async ({ page }) => {
    const response = await page.goto("/inbox");

    // The proxy must be the thing that redirects, before any React
    // runs. If this ever starts passing only because the client-side
    // guard in dashboard-shell.tsx fired, the server boundary has
    // regressed and every protected route is open to a client with
    // JavaScript disabled.
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/login/);
  });

  test("a seeded user can sign in and reach the inbox", async ({ page }) => {
    await loginAs(page, "acmeOwner");

    await page.goto("/inbox");
    await expect(page).toHaveURL(/\/inbox/);

    // The seeded contact name is the cheapest proof that the list
    // rendered real rows rather than an empty state.
    await expect(
      page.getByTestId("conversation-list").getByText(firstConversation.contactName),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("opening a conversation shows its thread", async ({ page }) => {
    await loginAs(page, "acmeOwner");
    await page.goto("/inbox");

    await page
      .getByTestId("conversation-list")
      .getByText(firstConversation.contactName)
      .click();

    // Scoped to the thread on purpose. The same text is also the list's
    // preview line, so an unscoped match resolves to two elements and
    // would pass even if the thread never opened.
    await expect(
      page.getByTestId("message-thread").getByText(firstConversation.firstMessage),
    ).toBeVisible({ timeout: 30_000 });
  });
});
