import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './support/auth';
import { conversationsFor } from './support/fixtures';

const [first, second, third] = conversationsFor('acme');

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
  await page.locator('textarea').first().fill('Borrador del primer chat');
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
  await page.route('**/rest/v1/*?*', async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === 'GET' &&
      /\/(deals|contact_notes|contact_tasks|contact_tags)$/.test(
        url.pathname
      ) &&
      url.searchParams.get('contact_id') === `eq.${second.contactId}`
    ) {
      await gate;
      await route.continue();
    } else await route.fallback();
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
    await expect(page.getByTestId('contact-skeleton')).toBeAttached();
    if ((page.viewportSize()?.width ?? 0) >= 1024) {
      await expect(
        page
          .getByTestId('contact-panel')
          .getByText(second.contactName, { exact: true })
      ).toBeVisible();
      await expect(page.getByTestId('contact-skeleton')).toBeVisible();
    }
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
    // Revisit A with its network revalidation held: cached content and draft
    // must be available before this second request completes.
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let requestedA = false;
    await page.route('**/rest/v1/messages?*', async (route) => {
      if (
        route.request().method() !== 'GET' ||
        new URL(route.request().url()).searchParams.get('conversation_id') !==
          `eq.${first.id}`
      ) {
        await route.fallback();
        return;
      }
      requestedA = true;
      await gateA;
      await route.continue();
    });
    try {
      await select(page, first.contactName);
      await expect(page).toHaveURL(new RegExp(`/inbox/${first.id}$`));
      await expect.poll(() => requestedA).toBe(true);
      await expect(thread.getByText(first.firstMessage)).toBeVisible();
      await expect(thread.getByTestId('thread-skeleton')).toHaveCount(0);
      await expect(page.locator('textarea').first()).toHaveValue(
        'Borrador del primer chat'
      );
      expect(queries).toBe(0);
      expect(
        await page.evaluate(() =>
          (window as unknown as { inboxProbe: () => boolean }).inboxProbe()
        )
      ).toBe(true);
      await testInfo.attach('retorno-con-cache-durante-la-espera', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    } finally {
      releaseA();
    }
  } finally {
    release();
  }
});

test('una respuesta abandonada no reemplaza el chat más reciente ni su contacto', async ({
  page,
}, testInfo) => {
  await loginAs(page, 'acmeAgent');
  await page.goto(`/inbox/${first.id}`);
  await expect(
    page.getByTestId('message-thread').getByText(first.firstMessage)
  ).toBeVisible();
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
    await expect(page.getByTestId('thread-skeleton')).toBeVisible();
    await select(page, third.contactName);
    await expect(page).toHaveURL(new RegExp(`/inbox/${third.id}$`));
    const thread = page.getByTestId('message-thread');
    await expect(thread.getByText(third.firstMessage)).toBeVisible();
    release();
    await expect(thread.getByText(second.firstMessage)).toHaveCount(0);
    await expect(thread).toHaveAttribute('data-conversation-id', third.id);
    await expect(
      thread
        .locator('..')
        .getByRole('heading', { name: third.contactName, exact: true })
    ).toBeVisible();
    await testInfo.attach('seleccion-rapida-final', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  } finally {
    release();
  }
});
