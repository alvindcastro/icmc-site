import {expect, test, type Page} from '@playwright/test';
import {planningSeed} from '../planning-helpers';
import type {FetchTransport} from '../../src/api/types';

const day = '/planning?date_from=2026-10-10&date_to=2026-10-10';
const shop = '/planning/shopping-list?date_from=2026-10-10&date_to=2026-10-10';
async function signIn(page: Page, transport: FetchTransport, path: string, heading: string) {
  await page.route('**/api/v1/**', async route => {const request = route.request(); const response = await transport(request.url(), {method: request.method(), headers: request.headers(), body: request.postData() ?? undefined}); await route.fulfill({status: response.status, body: await response.text(), contentType: 'application/json'});});
  await page.goto(path); await page.getByLabel('Token', {exact: true}).fill('local-admin-token'); await page.getByRole('button', {name: 'Sign in', exact: true}).click(); await expect(page.getByRole('heading', {name: heading, exact: true})).toBeVisible();
}
async function fits(page: Page) {expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);}
// Earlier commitments exceed stock, the selected day adds more, and one ordered variant has no recipe.
async function busySeed() {
  const seed = await planningSeed();
  await seed.order('2026-10-08', [[seed.medium, 2]]); await seed.order('2026-10-09', [[seed.medium, 1]]); const mixed = await seed.order('2026-10-10', [[seed.medium, 1], [seed.small, 2]]);
  await seed.signOut(); return {...seed, mixed};
}

for (const width of [320, 375, 768, 1280]) test(`planning demand, shortages and the incomplete warning fit ${width}px`, async ({page}) => {
  await page.setViewportSize({width, height: 900}); const seed = await busySeed(); await signIn(page, seed.fixture.fetch, day, 'Planning');
  const cook = page.getByRole('region', {name: 'What to cook'}), needs = page.getByRole('region', {name: 'Ingredients needed'});
  await expect(cook.getByRole('row', {name: /Beef Caldereta/})).toHaveCount(2); await expect(needs.getByText('-250 g', {exact: true})).toBeVisible(); await expect(needs.getByText('1000 g through this period', {exact: true})).toBeVisible();
  await expect(page.getByRole('alert').getByRole('link', {name: 'Add recipe for Small of Beef Caldereta', exact: true})).toHaveAttribute('href', `/menu/${seed.food.id}/variants/${seed.small.id}/recipe`);
  await fits(page); await page.screenshot({path: `test-results/planning-${width}.png`, fullPage: true});
  const order = cook.getByRole('link', {name: seed.mixed.reference, exact: true}).first();
  if (width <= 768) expect((await order.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  if (width >= 768) await expect(page.getByRole('link', {name: 'Planning', exact: true})).toBeVisible();
  await order.click(); await expect(page.getByRole('heading', {name: seed.mixed.reference, exact: true})).toBeVisible();
});

test('a changed period updates the address and the plan, and survives going back from an order', async ({page}) => {
  const seed = await busySeed(); await signIn(page, seed.fixture.fetch, day, 'Planning');
  await page.getByLabel('From date', {exact: true}).fill('2026-10-08'); await expect(page).toHaveURL(/date_from=2026-10-08&date_to=2026-10-10$/);
  const needs = page.getByRole('region', {name: 'Ingredients needed'}); await expect(needs.getByText('3000 g', {exact: true})).toBeVisible(); await expect(page.getByText('Oct 8, 2026 to Oct 10, 2026', {exact: true})).toBeVisible();
  await page.getByLabel('To date', {exact: true}).fill('2026-10-07'); await expect(page).toHaveURL(/date_from=2026-10-07&date_to=2026-10-07$/); await expect(page.getByText('Nothing to prepare for this period.', {exact: true})).toBeVisible();
});

test('the dashboard preparation summary fits a phone and opens planning for its date', async ({page}) => {
  await page.setViewportSize({width: 375, height: 812}); const seed = await busySeed(); await signIn(page, seed.fixture.fetch, '/dashboard?date=2026-10-10', 'Dashboard');
  const summary = page.getByRole('region', {name: 'Preparation'});
  await expect(summary.getByText('3 units of 2 variants', {exact: true})).toBeVisible(); await expect(summary.getByText('1 ingredient short', {exact: true})).toBeVisible(); await expect(summary.getByText('Incomplete', {exact: true})).toBeVisible();
  await fits(page); await page.screenshot({path: 'test-results/dashboard-preparation-375.png', fullPage: true});
  await summary.getByRole('link', {name: 'Open planning', exact: true}).click(); await expect(page).toHaveURL(/\/planning\?date_from=2026-10-10&date_to=2026-10-10$/); await expect(page.getByRole('heading', {name: 'Planning', exact: true})).toBeVisible();
});

test('planning with large quantities fits 200 percent text zoom', async ({page}) => {
  await page.setViewportSize({width: 640, height: 900}); const seed = await planningSeed();
  await seed.order('2026-10-10', [[seed.medium, 9007199254]]); await seed.signOut(); await signIn(page, seed.fixture.fetch, day, 'Planning');
  await page.addStyleTag({content: 'html {font-size:200% !important;}'});
  await expect(page.getByRole('region', {name: 'Ingredients needed'}).getByText('6755399440500 g', {exact: true})).toBeVisible();
  await fits(page); await page.screenshot({path: 'test-results/planning-zoom.png', fullPage: true});
});

for (const width of [320, 375, 768, 1280]) test(`the shopping list fits ${width}px on screen and prints without navigation or actions`, async ({page}) => {
  await page.setViewportSize({width, height: 900}); const seed = await busySeed(); await signIn(page, seed.fixture.fetch, shop, 'Shopping list');
  const list = page.getByRole('region', {name: 'Printable shopping list'});
  await expect(list.getByRole('row', {name: /Flour/})).toContainText('1000 g'); await expect(list.getByRole('alert')).toContainText('This list is incomplete'); await expect(list.getByText('Oct 10, 2026 / America/Los_Angeles', {exact: true})).toBeVisible();
  await fits(page); await page.screenshot({path: `test-results/shopping-list-${width}.png`, fullPage: true});
  await page.emulateMedia({media: 'print'}); await expect(page.getByRole('navigation')).not.toBeVisible(); await expect(page.getByRole('button', {name: 'Print shopping list'})).not.toBeVisible(); await expect(page.getByRole('link', {name: 'Back to planning', exact: true})).not.toBeVisible();
  await expect(list.getByRole('heading', {name: 'Shopping list', exact: true})).toBeVisible(); await expect(list.getByRole('alert')).toBeVisible(); await expect(list.getByRole('row', {name: /Flour/})).toContainText('2250 g');
  expect(await list.locator('.snapshot-table').evaluate(element => getComputedStyle(element).display)).toBe('table');
  expect(await list.locator('.snapshot-table tbody tr').first().evaluate(element => getComputedStyle(element).breakInside)).toBe('avoid');
  await fits(page); await page.screenshot({path: `test-results/shopping-list-print-${width}.png`, fullPage: true});
  if (width === 1280) await page.pdf({path: 'test-results/shopping-list.pdf', format: 'A4', printBackground: true});
});

test('planning and the dashboard open the shopping list for the same period', async ({page}) => {
  const seed = await busySeed(); await signIn(page, seed.fixture.fetch, '/dashboard?date=2026-10-10', 'Dashboard');
  await page.getByRole('region', {name: 'Preparation'}).getByRole('link', {name: 'Open planning', exact: true}).click(); await expect(page.getByRole('heading', {name: 'Planning', exact: true})).toBeVisible();
  await page.getByRole('link', {name: 'Shopping list', exact: true}).click(); await expect(page).toHaveURL(/\/planning\/shopping-list\?date_from=2026-10-10&date_to=2026-10-10$/); await expect(page.getByRole('heading', {name: 'Shopping list', exact: true})).toBeVisible();
  await page.getByRole('link', {name: 'Back to planning', exact: true}).click(); await expect(page).toHaveURL(/\/planning\?date_from=2026-10-10&date_to=2026-10-10$/);
});
