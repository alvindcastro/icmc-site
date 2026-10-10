import {expect, test, type Page} from '@playwright/test';
import {createFixtureTransport} from '../../src/api/fixtures';
import {seedOrder} from '../order-helpers';
import {createApiClient} from '../../src/api/client';
import type {Food} from '../../src/api/types';

async function orders(page: Page, seeded: boolean | number = false) {
  const fixture = createFixtureTransport({latency: 0});
  for (let i = 0; i < (typeof seeded === 'number' ? seeded : seeded ? 1 : 0); i++) await seedOrder(fixture.fetch);
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const response = await fixture.fetch(request.url(), {method: request.method(), headers: request.headers(), body: request.postData() ?? undefined});
    await route.fulfill({status: response.status, body: await response.text(), contentType: 'application/json'});
  });
  await page.goto('/orders'); await page.getByLabel('Token', {exact: true}).fill('local-admin-token');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Orders', exact: true})).toBeVisible();
  return fixture;
}
async function fill(page: Page, name = 'Browser Customer') {
  await page.getByLabel('Customer name', {exact: true}).fill(name); await page.getByLabel('Contact phone').fill('555-0100');
  await page.getByLabel('Fulfillment date').fill('2026-10-10'); await page.getByLabel('Fulfillment time').fill('12:00');
  const selector = page.getByLabel('Food and variant');
  const medium = await selector.locator('option').filter({hasText: /Beef Caldereta - Medium/}).getAttribute('value');
  await selector.selectOption(medium!); await page.getByRole('button', {name: 'Add item', exact: true}).click();
  await page.getByLabel('Quantity for item 1', {exact: true}).fill('2');
  const shanghai = await selector.locator('option').filter({hasText: /Shanghai Spring Rolls/}).getAttribute('value');
  await selector.selectOption(shanghai!); await page.getByRole('button', {name: 'Add item', exact: true}).click();
}
async function noOverflow(page: Page) {expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);}

test('dirty order blocks history navigation until staff explicitly leaves', async ({page}) => {
  await orders(page);
  await page.getByRole('link', {name: 'Dashboard', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Dashboard', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'New order', exact: true}).click();
  await page.getByLabel('Customer name', {exact: true}).fill('Unsaved customer');
  await page.evaluate(() => history.back());
  await expect(page.getByRole('heading', {name: 'Leave order?'})).toBeVisible();
  await page.getByRole('button', {name: 'Stay editing'}).click();
  await expect(page.getByLabel('Customer name', {exact: true})).toHaveValue('Unsaved customer');
  await expect(page).toHaveURL(/\/dashboard/);
  await page.evaluate(() => history.back());
  await page.getByRole('button', {name: 'Leave order', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Orders', exact: true})).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

for (const width of [320, 375, 768, 1280]) {
  test(`reservation entry, review and details fit ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height: 900}); await orders(page);
    await page.getByRole('button', {name: 'New order', exact: true}).click();
    await fill(page, 'Long customer name '.repeat(10).trim()); await page.getByLabel('Customer notes', {exact: true}).fill('Contact detail '.repeat(60));
    await page.getByLabel('Order notes', {exact: true}).fill('Preparation preference '.repeat(50));
    await noOverflow(page);
    const dialog = page.getByRole('dialog'); const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({path: `test-results/order-entry-${width}.png`, fullPage: true});
    await page.getByRole('button', {name: 'Review order', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Order review', exact: true})).toBeInViewport();
    await expect(page.getByRole('region', {name: 'Order review'}).getByText('$215.00', {exact: true}).first()).toBeVisible();
    await noOverflow(page); await page.screenshot({path: `test-results/order-review-${width}.png`, fullPage: true});
    await page.getByRole('button', {name: 'Confirm order', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'DEV-0001'})).toBeVisible(); await noOverflow(page);
    await page.screenshot({path: `test-results/order-details-${width}.png`, fullPage: true});
  });
}

test('order dialog keyboard focus, dismissal and pending confirmation', async ({page}) => {
  await orders(page); const create = page.getByRole('button', {name: 'New order', exact: true});
  await create.focus(); await page.keyboard.press('Enter'); await expect(page.getByLabel('Customer name', {exact: true})).toBeFocused();
  await page.keyboard.press('Shift+Tab'); expect(await page.getByRole('dialog').evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(create).toBeFocused();
  await create.click(); await fill(page); await page.getByRole('button', {name: 'Review order', exact: true}).click();
  await page.getByRole('button', {name: 'Save pending', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'DEV-0001'})).toBeVisible();
  await page.getByRole('button', {name: 'Review confirmation', exact: true}).click();
  await page.getByRole('button', {name: 'Confirm order', exact: true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.getByText('Confirmed', {exact: true}).first()).toBeVisible();
});

test('orders and review fit 200 percent text zoom and maximum safe monetary amount', async ({page}) => {
  await page.setViewportSize({width: 640, height: 900}); await orders(page, true);
  await page.addStyleTag({content: 'html {font-size: 200% !important;}'}); await noOverflow(page);
  await page.getByRole('link', {name: 'DEV-0001', exact: true}).click();
  await page.getByRole('button', {name: 'Edit order', exact: true}).click();
  await page.getByLabel('Tax amount', {exact: true}).fill('90071992547194.91');
  await page.getByRole('button', {name: 'Review order', exact: true}).click();
  await expect(page.getByRole('region', {name: 'Order review'}).getByText('$90,071,992,547,409.91', {exact: true}).first()).toBeVisible();
  const dialog = page.getByRole('dialog'); expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const row = dialog.locator('.snapshot-table tbody tr').first();
  expect((await row.locator('th').boundingBox())!.width).toBeGreaterThanOrEqual((await row.boundingBox())!.width - 1);
  expect(await row.locator('td').first().evaluate(element => {
    const style = getComputedStyle(element, '::before'); const context = document.createElement('canvas').getContext('2d')!;
    context.font = style.font; return parseFloat(getComputedStyle(element).gridTemplateColumns) >= context.measureText('Quantity').width;
  })).toBe(true);
  await page.getByRole('button', {name: 'Save changes', exact: true}).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', {name: 'Save changes', exact: true})).toBeInViewport(); await noOverflow(page);
  await page.screenshot({path: 'test-results/order-text-zoom.png', fullPage: true});
});

test('business-date dashboard links and filtered list return preserve scroll', async ({page}) => {
  await orders(page, 12);
  await page.getByLabel('Search orders', {exact: true}).fill('Sample'); await page.getByLabel('Order status filter').selectOption('confirmed');
  const target = page.locator('.order-table tbody tr').nth(9).getByRole('link'); await target.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => scrollY); expect(scroll).toBeGreaterThan(200); await target.click();
  await page.getByRole('link', {name: 'Back to orders', exact: true}).click();
  await expect(page.getByLabel('Search orders', {exact: true})).toHaveValue('Sample');
  await expect(page.getByLabel('Order status filter')).toHaveValue('confirmed');
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(scroll, 0);
  await page.getByRole('link', {name: 'Dashboard', exact: true}).click(); await page.getByLabel('Dashboard date').fill('2026-10-10');
  await expect(page.getByRole('link', {name: 'DEV-0001', exact: true})).toBeVisible();
});

test('confirmed order keeps original price, label and availability-independent snapshot in the editor', async ({page}) => {
  const fixture = await orders(page, true);
  const api = createApiClient({baseUrl: '/api/v1', transport: fixture.fetch});
  const menu = await api.request<{items: Food[]}>('/foods?limit=100'); const food = menu.items.find(food => food.name === 'Beef Caldereta')!; const variant = food.variants.find(variant => variant.label === 'Medium')!;
  await api.request(`/variants/${variant.id}`, {method: 'PATCH', operationId: 'browser-reprice', body: {expected_version: variant.version, price_minor: 9900, label: 'New menu label', available: false}});
  const latest = await api.request<Food>(`/foods/${food.id}`); await api.request(`/foods/${food.id}`, {method: 'PATCH', operationId: 'browser-rename', body: {expected_version: latest.version, name: 'New menu name', available: false}});
  await page.getByRole('link', {name: 'DEV-0001', exact: true}).click(); await page.getByRole('button', {name: 'Edit order', exact: true}).click();
  await expect(page.getByText('Medium / 1 tray / $80.00', {exact: true})).toBeVisible();
  await expect(page.getByText('Beef Caldereta', {exact: true})).toBeVisible();
  await page.getByLabel('Quantity for item 1', {exact: true}).fill('1'); await page.getByRole('button', {name: 'Review order', exact: true}).click();
  await expect(page.getByRole('region', {name: 'Order review'}).getByText('$135.00', {exact: true}).first()).toBeVisible();
  await page.getByRole('button', {name: 'Save changes', exact: true}).click(); await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('rowheader', {name: /Beef Caldereta.*Medium/})).toBeVisible(); await expect(page.getByText('$135.00', {exact: true}).first()).toBeVisible();
});
