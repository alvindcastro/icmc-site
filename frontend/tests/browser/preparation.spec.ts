import {expect, test, type Page} from '@playwright/test';
import {planningSeed} from '../planning-helpers';
import type {FetchTransport} from '../../src/api/types';

const entry = '/planning/prepare?date_from=2026-10-10&date_to=2026-10-10';
async function signIn(page: Page, transport: FetchTransport, path: string, heading: string) {
  await page.route('**/api/v1/**', async route => {const request = route.request(); const response = await transport(request.url(), {method: request.method(), headers: request.headers(), body: request.postData() ?? undefined}); await route.fulfill({status: response.status, body: await response.text(), contentType: 'application/json'});});
  await page.goto(path); await page.getByLabel('Token', {exact: true}).fill('local-admin-token'); await page.getByRole('button', {name: 'Sign in', exact: true}).click(); await expect(page.getByRole('heading', {name: heading, exact: true})).toBeVisible();
}
async function fits(page: Page) {expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);}
// Three Medium trays ordered for 2026-10-10 with preparation recording enabled and 2000 g of Flour in stock.
async function recordingSeed(quantity = 3) {
  const seed = await planningSeed({preparation: true}), saved = await seed.order('2026-10-10', [[seed.medium, quantity]]);
  return {...seed, saved};
}
const count = (page: Page, reference: string) => page.getByLabel(`Prepared now, ${reference} Medium of Beef Caldereta`, {exact: true});

for (const width of [320, 375, 768, 1280]) test(`preparation entry, review and record fit ${width}px`, async ({page}) => {
  await page.setViewportSize({width, height: 900}); const seed = await recordingSeed(); await seed.signOut(); await signIn(page, seed.fixture.fetch, entry, 'Record preparation');
  const field = count(page, seed.saved.reference); await expect(page.getByText('3 of 3 remaining', {exact: true})).toBeVisible();
  if (width <= 768) {expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44); expect((await page.getByRole('button', {name: 'Add Flour', exact: true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);}
  await field.fill('2'); await page.getByRole('button', {name: 'Add Flour', exact: true}).click(); await page.getByLabel('Flour quantity used', {exact: true}).fill('1.5'); await page.getByLabel('Flour unit', {exact: true}).selectOption('kg');
  await fits(page); await page.screenshot({path: `test-results/preparation-entry-${width}.png`, fullPage: true});
  await page.getByRole('button', {name: 'Review preparation', exact: true}).click();
  const review = page.getByRole('region', {name: 'Review before recording'});
  await expect(review.getByText('0 -> 2 of 3', {exact: true})).toBeVisible(); await expect(review.getByText('2000 g -> 500 g', {exact: true})).toBeVisible(); await expect(review.getByText('$18.00', {exact: true})).toBeVisible();
  await expect(count(page, seed.saved.reference)).not.toBeVisible(); await fits(page); await page.screenshot({path: `test-results/preparation-review-${width}.png`, fullPage: true});
  await page.getByRole('button', {name: 'Record preparation', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Preparation record', exact: true})).toBeVisible(); await expect(page.getByText('Preparation recorded.', {exact: true})).toBeVisible(); await expect(page).toHaveURL(/\/preparations\/fixture_preparation_/);
  await expect(page.getByRole('region', {name: 'Ingredients used'}).getByText('2000 g -> 500 g', {exact: true})).toBeVisible();
  await fits(page); await page.screenshot({path: `test-results/preparation-record-${width}.png`, fullPage: true});
  await page.getByRole('link', {name: 'Back to planning', exact: true}).click(); await expect(page).toHaveURL(/\/planning\?date_from=2026-10-10&date_to=2026-10-10$/);
  await expect(page.getByRole('region', {name: 'What to cook'}).getByText('1 remaining / Confirmed', {exact: true})).toBeVisible();
});

test('leaving a started preparation entry asks first and keeps the entries when staying', async ({page}) => {
  const seed = await recordingSeed(); await seed.signOut(); await signIn(page, seed.fixture.fetch, entry, 'Record preparation');
  await count(page, seed.saved.reference).fill('1'); await page.getByRole('link', {name: 'Back to planning', exact: true}).click();
  const guard = page.getByRole('dialog', {name: 'Leave preparation?'}); await expect(guard).toBeVisible();
  await guard.getByRole('button', {name: 'Stay editing', exact: true}).click(); await expect(count(page, seed.saved.reference)).toHaveValue('1'); await expect(page).toHaveURL(/\/planning\/prepare/);
  await page.getByRole('link', {name: 'Back to planning', exact: true}).click(); await guard.getByRole('button', {name: 'Leave preparation', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Planning', exact: true})).toBeVisible();
});

test('preparation entry with large quantities and a long ingredient name fits 200 percent text zoom', async ({page}) => {
  await page.setViewportSize({width: 640, height: 900}); const seed = await recordingSeed(9007199254), long = await seed.ingredient(`Ingredient ${'long name '.repeat(18)}`.trim());
  await seed.signOut(); await signIn(page, seed.fixture.fetch, entry, 'Record preparation'); await page.addStyleTag({content: 'html {font-size:200% !important;}'});
  await expect(page.getByText('9007199254 of 9007199254 remaining', {exact: true})).toBeVisible(); await count(page, seed.saved.reference).fill('9007199254');
  await page.getByRole('button', {name: `Add ${long.name}`, exact: true}).click(); await expect(page.getByLabel(`${long.name} quantity used`, {exact: true})).toBeVisible();
  await fits(page); await page.screenshot({path: 'test-results/preparation-zoom.png', fullPage: true});
});

test('a partly prepared order shows its counts on a phone and opens preparation for its date', async ({page}) => {
  await page.setViewportSize({width: 375, height: 812}); const seed = await recordingSeed(); await seed.prepare(seed.draft(seed.saved, 2, '1.5')); await seed.signOut();
  await signIn(page, seed.fixture.fetch, `/orders/${seed.saved.id}`, seed.saved.reference);
  await expect(page.getByText('2 prepared / 1 remaining', {exact: true})).toBeVisible(); await fits(page); await page.screenshot({path: 'test-results/order-partly-prepared-375.png', fullPage: true});
  await page.getByRole('link', {name: 'Record preparation', exact: true}).click(); await expect(page).toHaveURL(/\/planning\/prepare\?date_from=2026-10-10&date_to=2026-10-10$/);
  await expect(page.getByText('1 of 3 remaining', {exact: true})).toBeVisible();
});

test('a stock correction opened from a preparation record fits a phone and stays linked', async ({page}) => {
  await page.setViewportSize({width: 375, height: 812}); const seed = await recordingSeed(), done = await seed.prepare(seed.draft(seed.saved, 2, '1.5')); await seed.signOut();
  await signIn(page, seed.fixture.fetch, `/preparations/${done.preparation.id}`, 'Preparation record');
  const open = page.getByRole('button', {name: 'Correct stock for Flour', exact: true}); expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44); await open.click();
  const dialog = page.getByRole('dialog', {name: 'Correct stock'}); await expect(dialog.getByText('This movement will be linked to the preparation record.', {exact: true})).toBeVisible();
  await dialog.getByLabel('Stock change (g)', {exact: true}).fill('200'); await dialog.getByLabel('Reason', {exact: true}).fill('Unused flour returned'); await fits(page); await page.screenshot({path: 'test-results/preparation-correction-375.png', fullPage: true});
  await dialog.getByRole('button', {name: 'Review movement', exact: true}).click(); await dialog.getByRole('button', {name: 'Save movement', exact: true}).click();
  await expect(page.getByText('Stock movement saved.', {exact: true})).toBeVisible(); await expect(page.getByRole('link', {name: 'Preparation record', exact: true})).toHaveCount(2); await fits(page);
});

test('keyboard focus follows the review step instead of being lost', async ({page}) => {
  const seed = await recordingSeed(); await seed.signOut(); await signIn(page, seed.fixture.fetch, entry, 'Record preparation');
  const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName);
  await page.getByRole('button', {name: 'Review preparation', exact: true}).click(); await expect(page.getByRole('alert')).toContainText('Enter a prepared quantity'); expect(await focused()).toBe('preparation-note');
  await count(page, seed.saved.reference).fill('1'); await page.getByLabel('Note', {exact: true}).fill('Assembled from prepared stock.');
  await page.getByRole('button', {name: 'Review preparation', exact: true}).click(); await expect(page.getByRole('region', {name: 'Review before recording'})).toBeVisible(); expect(await focused()).toBe('review-heading');
  await page.getByRole('button', {name: 'Edit entries', exact: true}).click(); expect(await focused()).toBe('prepared-on');
});

for (const width of [320, 375, 768, 1280]) test(`a preparation correction, its review and the corrected record fit ${width}px`, async ({page}) => {
  await page.setViewportSize({width, height: 900}); const seed = await recordingSeed(), done = await seed.prepare(seed.draft(seed.saved, 2, '1.5')); await seed.signOut();
  await signIn(page, seed.fixture.fetch, `/preparations/${done.preparation.id}`, 'Preparation record');
  await page.getByRole('link', {name: 'Correct prepared counts', exact: true}).click(); await expect(page.getByRole('heading', {name: 'Correct preparation', exact: true})).toBeVisible();
  const change = page.getByLabel(`Change in prepared count, ${seed.saved.reference} Medium of Beef Caldereta`, {exact: true}); await expect(page.getByText('2 of 3 prepared', {exact: true})).toBeVisible();
  if (width <= 768) expect((await change.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByLabel('Reason for correction', {exact: true}).fill('Only one tray was cooked'); await change.fill('-1'); await page.getByLabel('Flour stock change (g)', {exact: true}).fill('750');
  await fits(page); await page.screenshot({path: `test-results/correction-entry-${width}.png`, fullPage: true});
  await page.getByRole('button', {name: 'Review correction', exact: true}).click(); const review = page.getByRole('region', {name: 'Review correction'});
  await expect(review.getByText('2 -> 1 of 3', {exact: true})).toBeVisible(); await expect(review.getByText('+750 g', {exact: true})).toBeVisible(); await expect(review.getByText('500 g -> 1250 g', {exact: true})).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('correction-review-heading'); await fits(page); await page.screenshot({path: `test-results/correction-review-${width}.png`, fullPage: true});
  await page.getByRole('button', {name: 'Record correction', exact: true}).click(); await expect(page.getByText('Correction recorded.', {exact: true})).toBeVisible(); await expect(page).toHaveURL(new RegExp(`/preparations/${done.preparation.id}$`));
  const listed = page.getByRole('region', {name: 'Corrections'}); await expect(listed.getByText('Only one tray was cooked', {exact: true})).toBeVisible(); await expect(listed.getByText('500 g -> 1250 g', {exact: true})).toBeVisible();
  await fits(page); await page.screenshot({path: `test-results/correction-record-${width}.png`, fullPage: true});
});
