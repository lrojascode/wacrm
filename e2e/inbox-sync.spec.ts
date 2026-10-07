import { expect, test, type Page } from '@playwright/test';
import type { Message } from '../src/types';
import { loginAs } from './support/auth';
import { conversationsFor } from './support/fixtures';

const [first, second] = conversationsFor('acme');

// Deterministic browser fixtures keep the test independent of WhatsApp and
// give both viewports a real scrollable chat. Auth and navigation use the app.
function longThread(conversationId: string): Message[] {
  const start = Date.now() - 80 * 60_000;
  return Array.from({ length: 80 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    conversation_id: conversationId,
    sender_type: 'customer',
    content_type: 'text',
    status: 'delivered',
    content_text: `Lectura ${i + 1}: mensaje de prueba para conservar el lugar de lectura mientras la conversación se sincroniza.`,
    created_at: new Date(start + i * 60_000).toISOString(),
  }));
}

async function controlledMessages(page: Page) {
  const rows = longThread(first.id);
  let held = false;
  let fail = false;
  let requests = 0;
  let release = () => {};
  let gate = Promise.resolve();
  await page.route('**/rest/v1/messages?*', async (route) => {
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers':
        route.request().headers()['access-control-request-headers'] ??
        'authorization,apikey,x-client-info,content-type',
    };
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const id = new URL(route.request().url()).searchParams.get(
      'conversation_id'
    );
    if (id !== `eq.${first.id}`) {
      await route.continue();
      return;
    }
    requests++;
    if (held) await gate;
    await route.fulfill({
      status: fail ? 500 : 200,
      headers,
      contentType: 'application/json',
      body: JSON.stringify(fail ? { message: 'temporary failure' } : rows),
    });
  });
  return {
    rows,
    requests: () => requests,
    hold: () => {
      held = true;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: (error = false) => {
      fail = error;
      held = false;
      release();
    },
  };
}

async function prepareReading(page: Page) {
  await loginAs(page, 'acmeAgent');
  const control = await controlledMessages(page);
  await page.goto(`/inbox/${first.id}`);
  const thread = page.getByTestId('message-thread');
  await expect(thread.locator('[data-message-id]')).toHaveCount(80);
  const refresh = page.getByRole('button', {
    name: /Actualizar conversación|Refresh conversation/i,
  });
  await expect(refresh).toBeEnabled();
  const draft = page.locator('textarea').first();
  await draft.fill('Borrador que debe conservarse');
  const position = await thread.evaluate((element) => {
    element.scrollTop = 400;
    element.dispatchEvent(new Event('scroll'));
    const bounds = element.getBoundingClientRect();
    const anchor = [
      ...element.querySelectorAll<HTMLElement>('[data-message-id]'),
    ].find((node) => node.getBoundingClientRect().bottom > bounds.top)!;
    return {
      id: anchor.dataset.messageId!,
      top: element.scrollTop,
      offset: anchor.getBoundingClientRect().top - bounds.top,
    };
  });
  // Observe the whole interval, so a flash followed by recovery cannot pass.
  await thread.evaluate((element, id) => {
    const bubble = [
      ...element.querySelectorAll<HTMLElement>('[data-message-id]'),
    ].find((node) => node.dataset.messageId === id)!;
    element.dataset.flashDetected = 'false';
    const observer = new MutationObserver(() => {
      if (!bubble.isConnected || element.querySelector('.animate-spin')) {
        element.dataset.flashDetected = 'true';
      }
    });
    observer.observe(element, { childList: true, subtree: true });
  }, position.id);
  return { control, thread, refresh, draft, position };
}

for (const trigger of ['tab', 'refresh'] as const) {
  test(`inbox conserva contenido, borrador y scroll durante ${trigger}`, async ({
    page,
  }) => {
    const { control, thread, refresh, draft, position } =
      await prepareReading(page);
    const before = control.requests();
    control.hold();
    if (trigger === 'refresh') await refresh.click();
    else {
      for (const state of ['hidden', 'visible'] as const) {
        await page.evaluate((value) => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => value,
          });
          document.dispatchEvent(new Event('visibilitychange'));
        }, state);
      }
    }
    await expect.poll(control.requests).toBe(before + 1);
    await expect(refresh).toBeDisabled();
    await expect(thread.locator('[data-message-id]')).toHaveCount(80);
    await expect(thread.locator('.animate-spin')).toHaveCount(0);
    await expect(draft).toHaveValue('Borrador que debe conservarse');
    // Exceeds the previous cosmetic 700 ms timeout while the response is held.
    await page.waitForTimeout(900);
    await expect(refresh).toBeDisabled();
    await expect
      .poll(() => thread.evaluate((element) => element.scrollTop))
      .toBeCloseTo(position.top, 0);
    control.release();
    await expect(refresh).toBeEnabled();
    await expect(thread).toHaveAttribute('data-flash-detected', 'false');
    await expect(draft).toHaveValue('Borrador que debe conservarse');
    const offset = await thread
      .locator(`[data-message-id="${position.id}"]`)
      .evaluate(
        (node) =>
          node.getBoundingClientRect().top -
          node
            .closest('[data-testid="message-thread"]')!
            .getBoundingClientRect().top
      );
    expect(offset).toBeCloseTo(position.offset, 0);
  });
}

test('una sincronización fallida conserva el chat y permite volver a refrescar', async ({
  page,
}) => {
  const { control, thread, refresh, draft, position } =
    await prepareReading(page);
  const before = control.requests();
  control.hold();
  await refresh.click();
  await expect.poll(control.requests).toBe(before + 1);
  control.release(true);
  await expect(refresh).toBeEnabled();
  await expect(thread.locator('[data-message-id]')).toHaveCount(80);
  await expect(draft).toHaveValue('Borrador que debe conservarse');
  await expect
    .poll(() => thread.evaluate((element) => element.scrollTop))
    .toBeCloseTo(position.top, 0);
  await expect(thread).toHaveAttribute('data-flash-detected', 'false');
  control.release(false);
  await refresh.click();
  await expect.poll(control.requests).toBe(before + 2);
  await expect(refresh).toBeEnabled();
});

test('seleccionar otro hilo no vacía el anterior antes de confirmar la navegación', async ({
  page,
}) => {
  const { thread } = await prepareReading(page);
  test.skip(
    (page.viewportSize()?.width ?? 0) < 1024,
    'la selección directa de otro hilo solo existe en escritorio'
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/inbox/${second.id}?*`, async (route) => {
    await gate;
    await route.continue();
  });
  // Also delay the target DB query: the next header must never show old bubbles.
  await page.route('**/rest/v1/messages?*', async (route) => {
    if (
      new URL(route.request().url()).searchParams.get('conversation_id') !==
      `eq.${second.id}`
    ) {
      await route.fallback();
      return;
    }
    await gate;
    await route.continue();
  });
  await page
    .getByTestId('conversation-list')
    .getByText(second.contactName)
    .click();
  const firstStillOpen = new URL(page.url()).pathname === `/inbox/${first.id}`;
  if (firstStillOpen)
    await expect(thread.locator('[data-message-id]')).toHaveCount(80);
  release();
  await expect(page).toHaveURL(new RegExp(`/inbox/${second.id}$`));
  await expect(thread.getByText(second.firstMessage)).toBeVisible();
  await expect(thread.getByText(/^Lectura /)).toHaveCount(0);
});
