// P0-BUG-04 — the open conversation is a location, not a piece of
// component state.
//
// Defect C from the root-cause analysis, and the only one of the four
// that reproduces deterministically with no auth involved at all: every
// selection used `router.replace`, so opening conversations never added
// history entries. After opening three of them the stack still held
// only whatever preceded /inbox — so Back left the inbox entirely and
// landed on the dashboard.

import { expect, test, type Page } from "@playwright/test";

import { loginAs, logout } from "./support/auth";
import {
  conversationsFor,
  MISSING_CONVERSATION_ID,
} from "./support/fixtures";

const [first, second, third] = conversationsFor("acme");

/**
 * Click a conversation and wait for its URL to settle.
 *
 * Two things this has to absorb:
 *
 *  - The wait. Clicking the next conversation before the previous
 *    navigation commits collapses two history entries into one, and the
 *    back/forward assertions then fail for a reason that has nothing to
 *    do with the code under test.
 *  - The viewport. Below `lg` the inbox is a SINGLE pane: opening a
 *    conversation hides the list, so reaching another one means going
 *    back to the list first. That is real user behaviour on a phone,
 *    not a test artefact, so the helper reproduces it rather than
 *    forcing the desktop flow.
 */
async function open(page: Page, contactName: string, id: string) {
  const list = page.getByTestId("conversation-list");

  // Below `lg` the inbox is a SINGLE pane: opening a conversation hides
  // the list, so reaching another one means going back to it first.
  // That is real behaviour on a phone, not a test artefact.
  //
  // Decide by viewport, not by whether the list happens to be visible
  // right now. The list element disappears briefly during a refetch
  // (the empty-state branch renders instead), and treating that as
  // "single pane" sent the helper hunting for a back button that does
  // not exist on desktop.
  const conversationOpen = /^\/inbox\/.+/.test(new URL(page.url()).pathname);
  if (conversationOpen && isSinglePane(page)) {
    await backToList(page);
  }

  await expect(list).toBeVisible({ timeout: 30_000 });
  await list.getByText(contactName).click();
  await expect(page).toHaveURL(new RegExp(`/inbox/${id}$`));
}

/**
 * Is the inbox in single-pane mode?
 *
 * 1024px is Tailwind's `lg`, the same breakpoint the layout uses to
 * switch between one pane and two (`lg:hidden` on the back control,
 * `hidden lg:flex` on the panes). Reading it from the viewport keeps
 * the test and the CSS agreeing on one number.
 */
function isSinglePane(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 1024;
}

/** The thread's back control. Only rendered below `lg`. */
function backControl(page: Page) {
  // Matches the aria-label from messages/{es,en}.json.
  return page.getByRole("button", { name: /Volver a conversaciones|Back to conversations/i });
}

async function backToList(page: Page) {
  await backControl(page).click();
  await expect(page).toHaveURL(/\/inbox$/);
}

test.describe("inbox · historial y rutas por conversación", () => {
  test("cada conversación tiene su propia URL", async ({ page }) => {
    await loginAs(page, "acmeOwner");
    await page.goto("/inbox");

    await open(page, first.contactName, first.id);
    await expect(page).toHaveURL(new RegExp(`/inbox/${first.id}$`));
    await expect(
      page.getByTestId("message-thread").getByText(first.firstMessage),
    ).toBeVisible();
  });

  test("Atrás recorre las conversaciones y termina en /inbox, nunca en /dashboard", async ({
    page,
  }) => {
    // Arrive from the dashboard, which is what makes the old behaviour
    // visible: it is the entry Back used to fall through to.
    await loginAs(page, "acmeOwner");
    await page.goto("/dashboard");
    await page.goto("/inbox");

    await open(page, first.contactName, first.id);
    await open(page, second.contactName, second.id);
    await open(page, third.contactName, third.id);

    // Walk back through every entry the inbox created. The exact
    // sequence differs by viewport — on a phone each conversation is
    // reached via the list, so there are more entries — hence asserting
    // the invariant rather than a fixed path: every step back stays
    // inside the inbox, and the last one lands on the list.
    for (let i = 0; i < 5; i++) {
      await page.goBack();
      await expect(page).toHaveURL(/\/inbox(\/|$)/);
      if (/\/inbox$/.test(new URL(page.url()).pathname + "")) break;
    }

    await expect(page).toHaveURL(/\/inbox$/);
    // The assertion the whole task exists for.
    expect(page.url()).not.toContain("/dashboard");
  });

  test("Adelante rehace el camino", async ({ page }) => {
    await loginAs(page, "acmeOwner");
    await page.goto("/inbox");

    await open(page, first.contactName, first.id);
    await open(page, second.contactName, second.id);

    // One step back leaves the second conversation; forward must return
    // to it, with its thread intact. Where exactly Back lands depends on
    // the viewport (see `open`), so only Forward is pinned here.
    await page.goBack();
    await expect(page).not.toHaveURL(new RegExp(`/inbox/${second.id}$`));
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/inbox/${second.id}$`));
    await expect(
      page.getByTestId("message-thread").getByText(second.firstMessage),
    ).toBeVisible();
  });

  test("refrescar sobre una conversación la recupera", async ({ page }) => {
    await loginAs(page, "acmeOwner");
    await page.goto("/inbox");
    await open(page, first.contactName, first.id);

    await page.reload();

    await expect(page).toHaveURL(new RegExp(`/inbox/${first.id}$`));
    await expect(
      page.getByTestId("message-thread").getByText(first.firstMessage),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("un enlace /inbox?c=<id> antiguo sigue funcionando", async ({ page }) => {
    await loginAs(page, "acmeOwner");

    // Old links are in chats and bookmarks; the 308 in next.config.ts
    // keeps them working.
    await page.goto(`/inbox?c=${first.id}`);

    await expect(page).toHaveURL(new RegExp(`/inbox/${first.id}$`));
    await expect(
      page.getByTestId("message-thread").getByText(first.firstMessage),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("cerrar la conversación vuelve a /inbox", async ({ page }) => {
    await loginAs(page, "acmeOwner");
    await page.goto("/dashboard");
    await page.goto("/inbox");
    await open(page, first.contactName, first.id);

    // Only rendered below `lg`, so this asserts on mobile and skips on
    // desktop rather than pretending to cover both.
    test.skip(!isSinglePane(page), "el control de volver solo existe bajo lg");

    await expect(backControl(page)).toBeVisible();
    await backToList(page);
    // Never the dashboard, even though that is where the user came from
    // — the control returns to the inbox, it does not pop history.
    expect(page.url()).not.toContain("/dashboard");
  });
});

// ============================================================
// P0-BUG-05 — a URL that cannot resolve must say so.
//
// Before this, an id the loaded list did not contain produced nothing
// at all: no selection, no error, no redirect. The user opened their
// link and got an empty pane with no explanation.
// ============================================================

test.describe("inbox · conversaciones que no se pueden abrir", () => {
  test("una conversación inexistente devuelve a /inbox con un mensaje", async ({
    page,
  }) => {
    await loginAs(page, "acmeOwner");
    await page.goto(`/inbox/${MISSING_CONVERSATION_ID}`);

    await expect(page).toHaveURL(/\/inbox$/, { timeout: 30_000 });
    await expect(page.getByText(/ya no está disponible|no longer available/i)).toBeVisible();
  });

  // El requisito de aislamiento del reporte: "nunca recuperar una
  // conversación perteneciente a otra cuenta".
  test("la conversación de otra cuenta no se abre ni se filtra su contenido", async ({
    page,
  }) => {
    const [globexConversation] = conversationsFor("globex");

    await loginAs(page, "acmeOwner");
    await page.goto(`/inbox/${globexConversation.id}`);

    await expect(page).toHaveURL(/\/inbox$/, { timeout: 30_000 });
    await expect(page.getByText(/ya no está disponible|no longer available/i)).toBeVisible();

    // Lo que de verdad importa: nada del otro inquilino llega al DOM.
    await expect(page.getByText(globexConversation.contactName)).toHaveCount(0);
    await expect(page.getByText(globexConversation.firstMessage)).toHaveCount(0);
  });

  test("un id mal formado se trata igual, sin quedarse cargando", async ({ page }) => {
    await loginAs(page, "acmeOwner");
    await page.goto("/inbox/no-soy-un-uuid");

    await expect(page).toHaveURL(/\/inbox$/, { timeout: 30_000 });
    await expect(page.getByText(/ya no está disponible|no longer available/i)).toBeVisible();
  });

  // El cambio de cuenta en el mismo contexto de navegador: el estado de
  // la cuenta anterior no debe sobrevivir.
  test("al cambiar de cuenta no queda rastro de la anterior", async ({ page }) => {
    const [acmeConversation] = conversationsFor("acme");
    const [globexConversation] = conversationsFor("globex");

    await loginAs(page, "acmeOwner");
    await page.goto(`/inbox/${acmeConversation.id}`);
    await expect(
      page.getByTestId("message-thread").getByText(acmeConversation.firstMessage),
    ).toBeVisible();

    await logout(page);
    await loginAs(page, "globexOwner");
    await page.goto("/inbox");

    await expect(
      page.getByTestId("conversation-list").getByText(globexConversation.contactName),
    ).toBeVisible({ timeout: 30_000 });
    // Ni la conversación de Acme ni su contacto asoman por ningún lado.
    await expect(page.getByText(acmeConversation.contactName)).toHaveCount(0);
    await expect(page.getByText(acmeConversation.firstMessage)).toHaveCount(0);
  });
});

// ============================================================
// P0-BUG-06 — el contexto de trabajo del Inbox sobrevive.
//
// Medido antes de implementar nada: el cambio de pestaña YA conservaba
// los filtros, porque P0-BUG-02 dejó el árbol montado y P0-BUG-04 hizo
// que moverse entre conversaciones re-renderice el mismo segmento. Lo
// que no sobrevivía era una recarga ni una vuelta desde otra sección,
// que sí remontan la página. Eso es lo que se cubre aquí.
// ============================================================

test.describe("inbox · el contexto de trabajo sobrevive", () => {
  const searchBox = (page: Page) => page.getByPlaceholder(/Buscar|Search/i);

  test("la búsqueda sobrevive a una recarga", async ({ page }) => {
    await loginAs(page, "acmeOwner");
    await page.goto("/inbox");
    await expect(page.getByTestId("conversation-list")).toBeVisible();

    await searchBox(page).fill(first.contactName);
    await expect(searchBox(page)).toHaveValue(first.contactName);

    await page.reload();

    await expect(page.getByTestId("conversation-list")).toBeVisible({ timeout: 30_000 });
    await expect(searchBox(page)).toHaveValue(first.contactName);
  });

  test("la búsqueda sobrevive a ir a otra sección y volver", async ({ page }) => {
    await loginAs(page, "acmeOwner");
    await page.goto("/inbox");
    await expect(page.getByTestId("conversation-list")).toBeVisible();

    await searchBox(page).fill(second.contactName);
    await expect(searchBox(page)).toHaveValue(second.contactName);

    await page.goto("/contacts");
    await page.goto("/inbox");

    await expect(page.getByTestId("conversation-list")).toBeVisible({ timeout: 30_000 });
    await expect(searchBox(page)).toHaveValue(second.contactName);
  });

  // Ya funcionaba antes de esta tarea; se fija como guardia de regresión
  // para que un cambio futuro en el gate de auth no vuelva a romperlo.
  test("la búsqueda sobrevive a un cambio de pestaña", async ({ page }) => {
    await loginAs(page, "acmeOwner");
    await page.goto("/inbox");
    await expect(page.getByTestId("conversation-list")).toBeVisible();

    await searchBox(page).fill(first.contactName);

    for (const state of ["hidden", "visible"] as const) {
      await page.evaluate((value) => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => value,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
      await page.waitForTimeout(500);
    }

    await expect(searchBox(page)).toHaveValue(first.contactName);
  });

  // El requisito explícito del criterio: cambiar de cuenta reinicia.
  test("cambiar de cuenta no hereda los filtros de la anterior", async ({ page }) => {
    await loginAs(page, "acmeOwner");
    await page.goto("/inbox");
    await expect(page.getByTestId("conversation-list")).toBeVisible();

    await searchBox(page).fill(first.contactName);
    await expect(searchBox(page)).toHaveValue(first.contactName);

    await logout(page);
    await loginAs(page, "globexOwner");
    await page.goto("/inbox");
    await expect(page.getByTestId("conversation-list")).toBeVisible({ timeout: 30_000 });

    // Un filtro heredado escondería conversaciones en silencio, que es
    // como se reporta "faltan mensajes".
    await expect(searchBox(page)).toHaveValue("");
  });
});
