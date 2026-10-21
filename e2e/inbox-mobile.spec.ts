import { test, expect, type Locator, type Page } from '@playwright/test';
import { inboxFixture, providerFixture } from './support/inbox';
import { loginAs } from './support/auth';

const more = (page: Page) =>
  page.getByRole('button', { name: /^(Más|More|More actions)$/i });
const send = (page: Page) =>
  page
    .getByRole('button', { name: /^(Enviar|Send)$/i })
    .and(page.locator('[aria-label]'));
const listRow = (page: Page, id: string) =>
  page
    .getByTestId('conversation-list')
    .locator(`button[data-conversation-id="${id}"]`);
async function bounds(locator: Locator) {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}
async function fits(locator: Locator, width: number, parent?: Locator) {
  const box = await bounds(locator);
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  if (parent) {
    const outer = await bounds(parent);
    expect(box.x).toBeGreaterThanOrEqual(outer.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
  }
  return box;
}

// These are real Next/Auth/REST/Storage flows. Only the final external
// Meta/AI fetch is replaced by the Node E2E transport, never the app API.
test('long names/URLs keep indicators and composer inside actual app geometry', async ({
  page,
}, info) => {
  const fixture = await inboxFixture(`Nombre${'MuyLargo'.repeat(80)}`);
  const sizes = [
    [320, 568],
    [360, 640],
    [390, 844],
    [414, 896],
    [639, 700],
    [640, 700],
    [1023, 800],
    [1024, 800],
    [1280, 800],
    [390, 400],
    [844, 390],
  ];
  const measurements = [];
  try {
    await loginAs(page, 'acmeAgent');
    for (const [width, height] of sizes) {
      await page.goto('/inbox');
      await fixture.message();
      const update = await fixture.admin
        .from('conversations')
        .update({
          last_message_text: `https://example.test/${'enlacemuyextenso'.repeat(100)}`,
        })
        .eq('id', fixture.id);
      expect(update.error).toBeNull();
      await page.setViewportSize({ width, height });
      await page.goto('/inbox');
      const row = listRow(page, fixture.id);
      await expect(row).toBeVisible();
      const indicator = await fits(
        row.locator('[data-unread-count]'),
        width,
        row
      );
      const status = await fits(row.locator('[title="open"]'), width, row);
      await expect(row.locator('[data-unread-count]')).toHaveText('1');
      expect(indicator.x + indicator.width).toBeLessThanOrEqual(status.x + 1);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        )
      ).toBeLessThanOrEqual(1);
      await row.click();
      const input = page.locator('textarea').first();
      await expect(input).toBeEnabled();
      const textBox = await fits(input, width);
      const sendBox = await fits(send(page), width);
      const plusBox = await fits(more(page), width);
      expect(textBox.width).toBeGreaterThanOrEqual(160);
      if (width < 640) {
        for (const box of [sendBox, plusBox]) {
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(44);
        }
        await expect(input).toHaveAttribute(
          'placeholder',
          /^(Escribe un mensaje|Type a message)\.\.\.$/
        );
        await expect(page.getByText(/Toca ✨|Tap ✨/)).toBeHidden();
      } else await expect(page.getByText(/Toca ✨|Tap ✨/)).toBeVisible();
      await input.fill('Texto de prueba');
      await more(page).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await menu.evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => {}))
        );
      });
      const menuBox = await fits(menu, width);
      expect(menuBox.y).toBeGreaterThanOrEqual(-1);
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(height + 1);
      if (width < 640) {
        const items = await menu.getByRole('menuitem').all();
        for (const item of items)
          expect((await bounds(item)).height).toBeGreaterThanOrEqual(44);
      }
      await page.keyboard.press('Escape');
      await expect
        .poll(async () => (await fixture.state()).unread_count)
        .toBe(0);
      measurements.push({
        width,
        height,
        indicator,
        status,
        textBox,
        sendBox,
        plusBox,
        menuBox,
      });
      if (width === 320 || width === 1280)
        await info.attach(`app-${width}`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
    }
    await info.attach('geometry', {
      body: JSON.stringify(measurements),
      contentType: 'application/json',
    });
  } finally {
    await fixture.cleanup();
  }
});

test('mobile menu executes AI, quick replies, interactive and text sends through real app routes', async ({
  page,
}) => {
  expect(
    process.env.E2E_PROVIDER_MOCKS,
    'Run with E2E_PROVIDER_MOCKS=1; no real providers are used'
  ).toBe('1');
  const fixture = await inboxFixture();
  let providers: Awaited<ReturnType<typeof providerFixture>> | undefined;
  try {
    providers = await providerFixture(fixture);
    await fixture.message();
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, 'acmeAgent');
    await page.goto(`/inbox/${fixture.id}`);
    const input = page.locator('textarea').first();
    await expect(input).toBeEnabled();
    await more(page).click();
    await page
      .getByRole('menuitem', { name: /Redactar.*IA|Draft.*AI/i })
      .click();
    await expect(input).toHaveValue('Borrador IA de prueba local');
    await send(page).click();
    await expect
      .poll(
        async () =>
          (
            await fixture.admin
              .from('messages')
              .select('id')
              .eq('conversation_id', fixture.id)
              .eq('sender_type', 'agent')
              .eq('content_text', 'Borrador IA de prueba local')
          ).data?.length
      )
      .toBe(1);
    await more(page).click();
    await page
      .getByRole('menuitem', { name: /Respuestas rápidas|Quick replies/i })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(providers.replyTitle) })
      .click();
    await expect(input).toHaveValue('Respuesta rápida local');
    await send(page).click();
    await more(page).click();
    await page
      .getByRole('menuitem', {
        name: /Mensaje interactivo|Interactive message/i,
      })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByPlaceholder('What the customer reads above the options')
      .fill('Elige una opción');
    await dialog.getByPlaceholder('Button label').fill('Confirmar');
    await dialog.getByRole('button', { name: /^(Enviar|Send)$/ }).click();
    await expect
      .poll(
        async () =>
          (
            await fixture.admin
              .from('messages')
              .select('id')
              .eq('conversation_id', fixture.id)
              .eq('content_type', 'interactive')
          ).data?.length
      )
      .toBe(1);
    await input.fill('Respuesta humana');
    await send(page).click();
    await expect
      .poll(
        async () =>
          (
            await fixture.admin
              .from('messages')
              .select('id')
              .eq('conversation_id', fixture.id)
              .eq('sender_type', 'agent')
              .eq('content_text', 'Respuesta humana')
          ).data?.length
      )
      .toBe(1);
    await expect(input).toHaveValue('');
    await page
      .getByRole('button', {
        name: /Volver a conversaciones|Back to conversations/i,
      })
      .click();
    await expect(page).toHaveURL('/inbox');
    await page.reload();
    expect((await fixture.state()).unread_count).toBe(0);
    await expect(
      listRow(page, fixture.id).locator('[data-unread-count]')
    ).toHaveCount(0);
  } finally {
    await providers?.cleanup();
    await fixture.cleanup();
  }
});

test('expired WhatsApp window keeps templates reachable and free-form actions disabled', async ({
  page,
}) => {
  expect(process.env.E2E_PROVIDER_MOCKS).toBe('1');
  const fixture = await inboxFixture();
  let providers: Awaited<ReturnType<typeof providerFixture>> | undefined;
  try {
    providers = await providerFixture(fixture);
    await fixture.message({ created_at: '2020-01-01T00:00:00Z' });
    await page.setViewportSize({ width: 320, height: 568 });
    await loginAs(page, 'acmeAgent');
    await page.goto(`/inbox/${fixture.id}`);
    await expect(page.locator('textarea').first()).toBeDisabled();
    await expect(more(page)).toBeEnabled();
    await more(page).click();
    for (const name of [
      /^(Foto|Photo)$/i,
      /Redactar.*IA|Draft.*AI/i,
      /Mensaje interactivo|Interactive message/i,
    ])
      await expect(page.getByRole('menuitem', { name })).toBeDisabled();
    await page
      .getByRole('menuitem', { name: /Enviar plantilla|Send template/i })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp(providers.templateName) })
      .click();
    await expect
      .poll(
        async () =>
          (
            await fixture.admin
              .from('messages')
              .select('id')
              .eq('conversation_id', fixture.id)
              .eq('content_type', 'template')
          ).data?.length
      )
      .toBe(1);
  } finally {
    await providers?.cleanup();
    await fixture.cleanup();
  }
});

test('mobile attachment chooser uploads to local Storage, cancels and sends', async ({
  page,
}) => {
  expect(process.env.E2E_PROVIDER_MOCKS).toBe('1');
  const fixture = await inboxFixture();
  let providers: Awaited<ReturnType<typeof providerFixture>> | undefined;
  try {
    providers = await providerFixture(fixture);
    await fixture.message();
    await page.setViewportSize({ width: 390, height: 600 });
    await loginAs(page, 'acmeAgent');
    await page.goto(`/inbox/${fixture.id}`);
    await expect(page.locator('textarea').first()).toBeEnabled();
    async function choose() {
      await more(page).click();
      const chooser = page.waitForEvent('filechooser');
      await page
        .getByRole('menuitem', { name: /^(Documento|Document)$/ })
        .click();
      await (
        await chooser
      ).setFiles({
        name: 'inbox-local.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Adjunto local de prueba'),
      });
      await expect(
        page.getByText('inbox-local.txt', { exact: true })
      ).toBeVisible();
    }
    await choose();
    await page
      .getByRole('button', { name: /Quitar adjunto|Remove attachment/i })
      .click();
    await expect(page.locator('textarea').first()).toBeVisible();
    await choose();
    await send(page).click();
    await expect
      .poll(
        async () =>
          (
            await fixture.admin
              .from('messages')
              .select('id')
              .eq('conversation_id', fixture.id)
              .eq('content_type', 'document')
          ).data?.length
      )
      .toBe(1);
  } finally {
    const prefix = `account-${fixture.accountId}`;
    const objects = await fixture.admin.storage.from('chat-media').list(prefix);
    const paths =
      objects.data
        ?.filter((object) => object.name.endsWith('-inbox-local.txt'))
        .map((object) => `${prefix}/${object.name}`) ?? [];
    if (paths.length)
      await fixture.admin.storage.from('chat-media').remove(paths);
    await providers?.cleanup();
    await fixture.cleanup();
  }
});
