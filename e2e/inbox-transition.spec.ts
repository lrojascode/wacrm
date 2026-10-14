import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './support/auth';
import { conversationsFor } from './support/fixtures';

const [first, second] = conversationsFor('acme');

async function select(page: Page, name: string) {
  if (
    (page.viewportSize()?.width ?? 0) < 1024 &&
    /\/inbox\/.+/.test(new URL(page.url()).pathname)
  ) {
    await page
      .getByRole('button', {
        name: /Volver a conversaciones|Back to conversations/i,
      })
      .click();
    await expect(page).toHaveURL(/\/inbox$/);
  }
  await page.getByTestId('conversation-list').getByText(name).click();
}

test('el Inbox permanece montado durante la navegación real a un hilo sin caché', async ({
  page,
}, testInfo) => {
  await loginAs(page, 'acmeAgent');
  await page.goto(`/inbox/${first.id}`);
  await expect(
    page.getByTestId('message-thread').getByText(first.firstMessage)
  ).toBeVisible();
  await expect(page.getByTestId('conversation-list')).toBeAttached();
  await page.evaluate(() => {
    const thread = document.querySelector('[data-testid="message-thread"]')!;
    const list = document.querySelector('[data-testid="conversation-list"]')!;
    const state = { disconnected: false };
    const observer = new MutationObserver(() => {
      if (!thread.isConnected || !list.isConnected) state.disconnected = true;
    });
    observer.observe(document.querySelector('main')!, {
      childList: true,
      subtree: true,
    });
    (window as unknown as { inboxProbe: () => boolean }).inboxProbe = () =>
      !state.disconnected && thread.isConnected && list.isConnected;
  });
  let queries = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      request.method() === 'GET' &&
      url.pathname.endsWith('/rest/v1/conversations') &&
      !url.searchParams.has('id')
    )
      queries++;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route('**/rest/v1/messages?*', async (route) => {
    if (
      route.request().method() !== 'GET' ||
      new URL(route.request().url()).searchParams.get('conversation_id') !==
        `eq.${second.id}`
    ) {
      await route.continue();
      return;
    }
    requested = true;
    await gate;
    await route.continue();
  });
  try {
    await select(page, second.contactName);
    await expect(page).toHaveURL(new RegExp(`/inbox/${second.id}$`));
    await expect.poll(() => requested).toBe(true);
    expect(
      await page.evaluate(() =>
        (window as unknown as { inboxProbe: () => boolean }).inboxProbe()
      )
    ).toBe(true);
    expect(queries).toBe(0);
    const thread = page.getByTestId('message-thread');
    await expect(thread.locator('[data-message-id]')).toHaveCount(0);
    await expect(thread.getByTestId('thread-skeleton')).toBeVisible();
    await expect(thread.locator('.animate-spin')).toHaveCount(0);
    await expect(page.locator('textarea').first()).toBeDisabled();
    await testInfo.attach('transicion-durante-la-espera', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    release();
    await expect(thread.getByText(second.firstMessage)).toBeVisible();
    expect(
      await page.evaluate(() =>
        (window as unknown as { inboxProbe: () => boolean }).inboxProbe()
      )
    ).toBe(true);
  } finally {
    release();
  }
});
