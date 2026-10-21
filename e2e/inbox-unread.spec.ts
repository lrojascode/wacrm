import { test, expect, devices, type Page } from '@playwright/test';
import { loginAs } from './support/auth';
import { inboxFixture, providerFixture } from './support/inbox';

const row = (page: Page, id: string) =>
  page
    .getByTestId('conversation-list')
    .locator(`button[data-conversation-id="${id}"]`);
async function visibility(page: Page, value: 'hidden' | 'visible') {
  await page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: state,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}

for (const secondUser of ['acmeAgent', 'acmeAgentTwo']) {
  test(`persisted receipt converges in two sessions: ${secondUser}`, async ({
    page,
    browser,
  }, info) => {
    const fixture = await inboxFixture();
    const otherContext = await browser.newContext({
      ...(info.project.name === 'mobile-safari' ? devices['iPhone 13'] : {}),
      baseURL: (info.project.use.baseURL as string) ?? 'http://localhost:3100',
    });
    const other = await otherContext.newPage();
    try {
      await fixture.message();
      await loginAs(page, 'acmeAgent');
      await loginAs(other, secondUser);
      await page.goto('/inbox');
      await other.goto('/inbox');
      await expect(
        row(page, fixture.id).locator('[data-unread-count]')
      ).toHaveText('1');
      await expect(
        row(other, fixture.id).locator('[data-unread-count]')
      ).toHaveText('1');
      await row(page, fixture.id).click();
      await expect(page.getByTestId('message-thread')).toHaveAttribute(
        'data-conversation-id',
        fixture.id
      );
      await expect
        .poll(async () => (await fixture.state()).unread_count)
        .toBe(0);
      await expect(
        row(other, fixture.id).locator('[data-unread-count]')
      ).toHaveCount(0, { timeout: 25_000 });
      await page.goto('/inbox');
      await page.reload();
      await other.reload();
      for (const session of [page, other]) {
        await expect(row(session, fixture.id)).toBeVisible();
        await expect(
          row(session, fixture.id).locator('[data-unread-count]')
        ).toHaveCount(0);
      }
      await info.attach('two-session-persisted-state', {
        body: JSON.stringify(await fixture.state()),
        contentType: 'application/json',
      });
    } finally {
      await otherContext.close();
      await fixture.cleanup();
    }
  });
}

for (const direct of [false, true]) {
  test(`does not acknowledge before history is loaded (${direct ? 'URL' : 'list'})`, async ({
    page,
  }) => {
    const fixture = await inboxFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await fixture.message();
      await loginAs(page, 'acmeAgent');
      await page.route('**/rest/v1/messages?*', async (route) => {
        if (
          new URL(route.request().url()).searchParams.get('conversation_id') ===
          `eq.${fixture.id}`
        )
          await gate;
        await route.continue();
      });
      await page.goto(direct ? `/inbox/${fixture.id}` : '/inbox');
      if (!direct) await row(page, fixture.id).click();
      await expect(page.getByTestId('message-thread')).toHaveAttribute(
        'aria-busy',
        'true'
      );
      expect((await fixture.state()).unread_count).toBe(1);
      release();
      await expect
        .poll(async () => (await fixture.state()).unread_count)
        .toBe(0);
    } finally {
      release();
      await fixture.cleanup();
    }
  });
}

test('hidden chats and old scroll positions retain new unread messages until presented', async ({
  page,
}) => {
  const fixture = await inboxFixture();
  try {
    const messages = Array.from({ length: 60 }, (_, i) => ({
      conversation_id: fixture.id,
      sender_type: 'customer',
      content_type: 'text',
      content_text: `Historial ${i} ${'contenido '.repeat(15)}`,
      status: 'delivered',
    }));
    const inserted = await fixture.admin.from('messages').insert(messages);
    expect(inserted.error).toBeNull();
    await loginAs(page, 'acmeAgent');
    await page.goto(`/inbox/${fixture.id}`);
    await expect.poll(async () => (await fixture.state()).unread_count).toBe(0);
    await visibility(page, 'hidden');
    await fixture.message({ content_text: 'Llegó en segundo plano' });
    await expect(page.getByTestId('message-thread')).toContainText(
      'Llegó en segundo plano'
    );
    expect((await fixture.state()).unread_count).toBe(1);
    await visibility(page, 'visible');
    await expect.poll(async () => (await fixture.state()).unread_count).toBe(0);
    const thread = page.getByTestId('message-thread');
    await thread.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await fixture.message({
      content_text: 'Llegó mientras revisaba historial',
    });
    await expect(thread).toContainText('Llegó mientras revisaba historial');
    expect((await fixture.state()).unread_count).toBe(1);
    await expect
      .poll(() => thread.evaluate((element) => element.scrollTop))
      .toBe(0);
    await thread.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(async () => (await fixture.state()).unread_count).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test('failed receipt survives list/reload/offline and only acknowledges previously presented IDs', async ({
  page,
  context,
}) => {
  const fixture = await inboxFixture();
  let attempts = 0;
  try {
    await fixture.message();
    await loginAs(page, 'acmeAgent');
    await page.route('**/rpc/acknowledge_inbox_messages', (route) => {
      attempts++;
      return route.abort('internetdisconnected');
    });
    await page.goto(`/inbox/${fixture.id}`);
    await expect.poll(() => attempts).toBeGreaterThan(0);
    expect((await fixture.state()).unread_count).toBe(1);
    await page.goto('/inbox');
    await page.reload();
    await expect(row(page, fixture.id)).toBeVisible();
    await context.setOffline(true);
    await fixture.message({ content_text: 'Nuevo sin presentar' });
    expect((await fixture.state()).unread_count).toBe(2);
    await page.unroute('**/rpc/acknowledge_inbox_messages');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(async () => (await fixture.state()).unread_count).toBe(1);
    await expect(
      row(page, fixture.id).locator('[data-unread-count]')
    ).toHaveText('1');
    expect(attempts).toBeLessThanOrEqual(5);
  } finally {
    await context.setOffline(false);
    await fixture.cleanup();
  }
});

test('viewer reads history without modifying shared unread state', async ({
  page,
}) => {
  const fixture = await inboxFixture();
  try {
    const incoming = await fixture.message();
    await loginAs(page, 'acmeViewer');
    await page.goto(`/inbox/${fixture.id}`);
    await expect(page.getByTestId('message-thread')).toContainText(
      incoming.content_text
    );
    await expect(page.locator('textarea').first()).toBeDisabled();
    await page.goto('/inbox');
    await page.reload();
    await expect(
      row(page, fixture.id).locator('[data-unread-count]')
    ).toHaveText('1');
    expect((await fixture.state()).unread_count).toBe(1);
  } finally {
    await fixture.cleanup();
  }
});

test('history beyond the REST row cap is loaded and acknowledged without omissions', async ({
  page,
}) => {
  const fixture = await inboxFixture();
  try {
    const result = await fixture.admin.from('messages').insert(
      Array.from({ length: 1001 }, (_, i) => ({
        conversation_id: fixture.id,
        sender_type: 'customer',
        content_type: 'text',
        content_text: `Mensaje paginado ${i}`,
        status: 'delivered',
        created_at: '2026-10-20T10:00:00Z',
      }))
    );
    expect(result.error).toBeNull();
    expect((await fixture.state()).unread_count).toBe(1001);
    await loginAs(page, 'acmeAgent');
    await page.goto(`/inbox/${fixture.id}`);
    await expect(
      page.getByTestId('message-thread').locator('[data-message-id]')
    ).toHaveCount(1001, { timeout: 30_000 });
    await expect
      .poll(async () => (await fixture.state()).unread_count, {
        timeout: 30_000,
      })
      .toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test('automatic outgoing messages do not invent or clear badges in either agent session', async ({
  page,
  browser,
}, info) => {
  const fixture = await inboxFixture();
  const context = await browser.newContext({
    ...(info.project.name === 'mobile-safari' ? devices['iPhone 13'] : {}),
    baseURL: (info.project.use.baseURL as string) ?? 'http://localhost:3100',
  });
  const other = await context.newPage();
  try {
    await loginAs(page, 'acmeAgent');
    await loginAs(other, 'acmeAgentTwo');
    await page.goto('/inbox');
    await other.goto('/inbox');
    for (const session of [page, other]) {
      await expect(row(session, fixture.id)).toBeVisible();
      await expect(
        session.locator('[data-realtime-connected="true"]')
      ).toBeVisible();
    }
    await fixture.message({
      sender_type: 'bot',
      content_text: 'Respuesta automática sin lectura',
    });
    for (const session of [page, other]) {
      await expect(row(session, fixture.id)).toContainText(
        'Respuesta automática sin lectura',
        { timeout: 25_000 }
      );
      await expect(
        row(session, fixture.id).locator('[data-unread-count]')
      ).toHaveCount(0);
    }
    expect((await fixture.state()).unread_count).toBe(0);
    await fixture.message();
    await fixture.message({
      sender_type: 'bot',
      content_text: 'Bot después del entrante',
    });
    for (const session of [page, other])
      await expect(
        row(session, fixture.id).locator('[data-unread-count]')
      ).toHaveText('1', { timeout: 25_000 });
    expect((await fixture.state()).unread_count).toBe(1);
  } finally {
    await context.close();
    await fixture.cleanup();
  }
});

test('an incoming message during a human response remains unread while the browser is hidden', async ({
  page,
}) => {
  expect(process.env.E2E_PROVIDER_MOCKS).toBe('1');
  const fixture = await inboxFixture();
  let providers: Awaited<ReturnType<typeof providerFixture>> | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    providers = await providerFixture(fixture);
    await fixture.message();
    await loginAs(page, 'acmeAgent');
    await page.goto(`/inbox/${fixture.id}`);
    await expect.poll(async () => (await fixture.state()).unread_count).toBe(0);
    await page.route('**/api/whatsapp/send', async (route) => {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    await page.locator('textarea').first().fill('Respuesta concurrente');
    await page.getByRole('button', { name: /^(Enviar|Send)$/ }).click();
    await expect
      .poll(
        async () =>
          (
            await fixture.admin
              .from('messages')
              .select('id')
              .eq('conversation_id', fixture.id)
              .eq('sender_type', 'agent')
          ).data?.length
      )
      .toBe(1);
    await visibility(page, 'hidden');
    await fixture.message({ content_text: 'Entrante durante respuesta' });
    release();
    await expect(page.locator('textarea').first()).toHaveValue('');
    expect((await fixture.state()).unread_count).toBe(1);
    await visibility(page, 'visible');
    await expect.poll(async () => (await fixture.state()).unread_count).toBe(0);
  } finally {
    release();
    await providers?.cleanup();
    await fixture.cleanup();
  }
});
