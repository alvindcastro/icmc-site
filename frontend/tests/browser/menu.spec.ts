import { expect, test, type Page } from '@playwright/test';
import { createFixtureTransport } from '../../src/api/fixtures';

async function menu(page: Page) {
  const fixture = createFixtureTransport({latency: 0});
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const response = await fixture.fetch(request.url(), {method: request.method(), headers: request.headers(), body: request.postData() ?? undefined});
    await route.fulfill({status: response.status, body: await response.text(), contentType: 'application/json'});
  });
  await page.goto('/menu');
  await page.getByLabel('Token', {exact: true}).fill('local-admin-token');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Beef Caldereta', exact: true})).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const width of [320, 375, 768, 1280]) {
  test(`menu editor, long text and multiple variants fit ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height: 900});
    await menu(page);
    await noOverflow(page);
    if (width <= 768) {
      const row = page.locator('.variant-table tbody tr').first();
      const label = row.locator('th');
      expect((await label.boundingBox())!.width).toBeGreaterThanOrEqual((await row.boundingBox())!.width - 52);
    }
    await page.screenshot({path: `test-results/menu-${width}.png`, fullPage: true});
    await page.getByRole('button', {name: 'Add food', exact: true}).click();
    const dialog = page.getByRole('dialog');
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
    const name = 'Long food name '.repeat(10).trim();
    await page.getByLabel('Food name').fill(name);
    await page.getByLabel('Food category').selectOption('beef');
    await page.getByLabel('Description').fill('A detailed menu description '.repeat(20));
    await page.screenshot({path: `test-results/menu-food-editor-${width}.png`, fullPage: true});
    await page.getByRole('button', {name: 'Save food'}).click();
    await expect(page.getByRole('heading', {name, exact: true})).toBeVisible();
    await noOverflow(page);
    await page.getByRole('button', {name: `Add variant to ${name}`, exact: true}).click();
    await page.getByLabel('Variant label').fill('Package label '.repeat(10).trim());
    await page.getByLabel('Selling unit').selectOption('package');
    await page.getByLabel('Price (USD)').fill('90071992547409.91');
    await page.getByLabel('Pieces per package').fill('100');
    await noOverflow(page);
    await page.screenshot({path: `test-results/menu-variant-editor-${width}.png`, fullPage: true});
    await page.getByRole('button', {name: 'Save variant'}).click();
    await expect(page.getByText('$90,071,992,547,409.91', {exact: true})).toBeVisible();
    await page.getByRole('button', {name: `Add variant to ${name}`, exact: true}).click();
    await page.getByLabel('Variant label').fill('Each piece');
    await page.getByLabel('Selling unit').selectOption('piece');
    await page.getByLabel('Price (USD)').fill('3');
    await page.getByLabel('Variant available').uncheck();
    await page.getByRole('button', {name: 'Save variant'}).click();
    await expect(page.getByRole('button', {name: `Edit variant Each piece of ${name}`, exact: true})).toBeEnabled();
    await noOverflow(page);
    await page.screenshot({path: `test-results/menu-long-${width}.png`, fullPage: true});
  });
}

test('menu keyboard dialog focus, discard protection and return focus', async ({page}) => {
  await menu(page);
  const edit = page.getByRole('button', {name: 'Edit food Beef Caldereta', exact: true});
  await edit.focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('Food name')).toBeFocused();
  const dialog = page.getByRole('dialog');
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible(); await expect(edit).toBeFocused();
  await edit.click(); await page.getByLabel('Description').fill('Unsaved description');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', {name: 'Discard changes?'})).toBeVisible();
  await page.getByRole('button', {name: 'Keep editing'}).click();
  await expect(page.getByLabel('Description')).toHaveValue('Unsaved description');
  await page.keyboard.press('Escape'); await page.getByRole('button', {name: 'Discard changes', exact: true}).click();
  await expect(edit).toBeFocused();
});

test('menu and package editor remain readable at 200 percent text zoom', async ({page}) => {
  await page.setViewportSize({width: 640, height: 900});
  await menu(page);
  await page.addStyleTag({content: 'html {font-size: 200% !important;}'});
  await noOverflow(page);
  await page.getByRole('button', {name: 'Add variant to Shanghai Spring Rolls', exact: true}).click();
  await page.getByLabel('Selling unit').selectOption('package');
  await page.getByLabel('Variant label').fill('A large package');
  await page.getByLabel('Price (USD)').fill('55');
  await page.getByLabel('Pieces per package').fill('100');
  await page.getByRole('button', {name: 'Save variant'}).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', {name: 'Save variant'})).toBeInViewport();
  await noOverflow(page);
  await page.screenshot({path: 'test-results/menu-text-zoom.png', fullPage: true});
});
