import {expect, test, type Page} from '@playwright/test';
import {recipeSeed} from '../recipe-helpers';
import type {FetchTransport} from '../../src/api/types';

type Seed = Awaited<ReturnType<typeof recipeSeed>>;
const recipePath = (seed: Seed) => `/menu/${seed.food.id}/variants/${seed.variant.id}/recipe`;
async function signIn(page: Page, transport: FetchTransport, path: string, heading: string) {
  await page.route('**/api/v1/**', async route => {const request = route.request(); const response = await transport(request.url(), {method: request.method(), headers: request.headers(), body: request.postData() ?? undefined}); await route.fulfill({status: response.status, body: await response.text(), contentType: 'application/json'});});
  await page.goto(path); await page.getByLabel('Token', {exact: true}).fill('local-admin-token'); await page.getByRole('button', {name: 'Sign in', exact: true}).click(); await expect(page.getByRole('heading', {name: heading, exact: true})).toBeVisible();
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (await page.getByRole('dialog').count()) expect(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
}
async function draftFlour(page: Page, quantity: string) {
  await page.getByLabel('Find ingredient').fill('flour'); await page.getByRole('button', {name: 'Add Flour', exact: true}).click(); await page.getByLabel('Quantity of Flour', {exact: true}).fill(quantity);
}

for (const width of [320, 375, 768, 1280]) test(`menu recipe links, recipe entry and the ingredient estimate fit ${width}px`, async ({page}) => {
  await page.setViewportSize({width, height: 900}); const seed = await recipeSeed(); await seed.signOut(); await signIn(page, seed.fixture.fetch, '/menu?q=caldereta', 'Menu');
  const link = page.getByRole('link', {name: 'Add recipe for Medium of Beef Caldereta', exact: true}); await expect(link).toBeVisible(); if (width >= 768) await expect(page.getByRole('link', {name: 'Menu & Recipes', exact: true})).toBeVisible();
  await fits(page); expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44); await page.screenshot({path: `test-results/menu-recipes-${width}.png`, fullPage: true});
  await link.click(); await expect(page.getByRole('heading', {name: 'Beef Caldereta', exact: true})).toBeVisible(); await expect(page.getByText('No recipe for this variant.', {exact: true})).toBeVisible(); await fits(page);
  await page.getByRole('button', {name: 'Add recipe', exact: true}).click(); await expect(page.getByLabel('Find ingredient')).toBeFocused(); await draftFlour(page, '750');
  await fits(page); await page.screenshot({path: `test-results/recipe-editor-${width}.png`, fullPage: true});
  await page.getByRole('button', {name: 'Save recipe', exact: true}).click(); await expect(page.getByText('Recipe saved.', {exact: true})).toBeVisible();
  const estimate = page.getByRole('region', {name: 'Ingredient estimate'}); await expect(estimate.getByText('Complete', {exact: true})).toBeVisible();
  await expect(estimate.locator('.estimate-totals')).toContainText('$9.00'); await expect(estimate.locator('.estimate-totals')).toContainText('$71.00'); await expect(estimate.getByText('$12.00 / kg', {exact: true})).toBeVisible();
  await fits(page); await page.screenshot({path: `test-results/recipe-estimate-${width}.png`, fullPage: true});
  if (width <= 768) {const receipt = estimate.getByRole('link', {name: 'Purchase receipt', exact: true}); expect(await receipt.evaluate(el => getComputedStyle(el).gridColumnStart)).toBe('2'); expect((await receipt.boundingBox())!.height).toBeGreaterThanOrEqual(44);}
  await page.getByRole('link', {name: 'Back to menu', exact: true}).click(); await expect(page).toHaveURL(/\/menu\?q=caldereta$/); await expect(page.getByRole('link', {name: 'Recipe and estimate for Medium of Beef Caldereta', exact: true})).toBeVisible(); await fits(page);
});

test('an unpriced ingredient stays incomplete on a phone with a link to its record', async ({page}) => {
  await page.setViewportSize({width: 375, height: 812}); const seed = await recipeSeed(), salt = await seed.ingredient('Salt');
  await seed.put([{ingredient_id: seed.flour.id, quantity: '750', unit: 'g'}, {ingredient_id: salt.id, quantity: '5', unit: 'g'}]); await seed.signOut(); await signIn(page, seed.fixture.fetch, recipePath(seed), 'Beef Caldereta');
  const estimate = page.getByRole('region', {name: 'Ingredient estimate'}); await expect(estimate.locator('.status-label')).toHaveText('Incomplete'); await expect(estimate.locator('.estimate-totals')).not.toContainText('$0.00');
  await expect(estimate.getByRole('alert').getByRole('link', {name: 'Salt', exact: true})).toHaveAttribute('href', `/ingredients/${salt.id}`); await expect(estimate.getByText('No purchase price', {exact: true})).toBeVisible();
  await fits(page); await page.screenshot({path: 'test-results/recipe-incomplete-375.png', fullPage: true});
});

test('keyboard focus returns and dirty history navigation names the recipe', async ({page}) => {
  const seed = await recipeSeed({recipe: true}); await seed.signOut(); await signIn(page, seed.fixture.fetch, '/menu?q=caldereta', 'Menu');
  await page.getByRole('link', {name: 'Recipe and estimate for Medium of Beef Caldereta', exact: true}).click(); await expect(page.getByRole('heading', {name: 'Beef Caldereta', exact: true})).toBeVisible();
  const edit = page.getByRole('button', {name: 'Edit recipe', exact: true}); await edit.focus(); await page.keyboard.press('Enter'); await expect(page.getByLabel('Find ingredient')).toBeFocused();
  await page.keyboard.press('Shift+Tab'); expect(await page.getByRole('dialog').evaluate(el => el.contains(document.activeElement))).toBe(true); await page.keyboard.press('Escape'); await expect(edit).toBeFocused();
  await edit.click(); await page.getByLabel('Quantity of Flour', {exact: true}).fill('500'); await page.evaluate(() => history.back()); await expect(page.getByRole('heading', {name: 'Leave recipe?'})).toBeVisible();
  await page.getByRole('button', {name: 'Stay editing'}).click(); await expect(page.getByRole('heading', {name: 'Leave recipe?'})).not.toBeVisible(); await expect(page.getByLabel('Quantity of Flour', {exact: true})).toHaveValue('500');
  await page.getByLabel('Quantity of Flour', {exact: true}).focus(); await page.keyboard.press('Escape'); await page.getByRole('button', {name: 'Discard changes'}).click(); await expect(edit).toBeFocused();
  await expect(page.getByRole('region', {name: 'Recipe', exact: true}).getByText('750 g', {exact: true})).toBeVisible();
});

test('a long ingredient name and the maximum safe cost fit 200 percent text zoom', async ({page}) => {
  await page.setViewportSize({width: 640, height: 900}); const seed = await recipeSeed({purchase: false}), long = await seed.ingredient('IngredientLongName'.repeat(11));
  await seed.buy(long.id, {total_cost_minor: Number.MAX_SAFE_INTEGER}); await seed.put([{ingredient_id: long.id, quantity: '2', unit: 'kg'}]); await seed.signOut(); await signIn(page, seed.fixture.fetch, recipePath(seed), 'Beef Caldereta');
  await page.addStyleTag({content: 'html {font-size:200% !important;}'});
  const totals = page.getByRole('region', {name: 'Ingredient estimate'}).locator('.estimate-totals'); await expect(totals).toContainText('$90,071,992,547,409.91'); await expect(totals).toContainText('-$90,071,992,547,329.91');
  await fits(page); await page.screenshot({path: 'test-results/recipe-zoom.png', fullPage: true});
  await page.getByRole('button', {name: 'Edit recipe', exact: true}).click(); await expect(page.getByLabel('Find ingredient')).toBeFocused(); await fits(page);
});

test('expiry clears a recipe draft, returns to the recipe after sign-in and never replays the save', async ({page}) => {
  const seed = await recipeSeed(); await seed.signOut(); let puts = 0;
  await signIn(page, async (input, init) => {if (String(input).endsWith('/recipe') && init?.method === 'PUT') {puts++; seed.fixture.expire();} return seed.fixture.fetch(input, init);}, recipePath(seed), 'Beef Caldereta');
  await page.getByRole('button', {name: 'Add recipe', exact: true}).click(); await draftFlour(page, '750'); await page.getByRole('button', {name: 'Save recipe', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Sign in', exact: true})).toBeVisible(); expect(await page.getByLabel('Quantity of Flour').count()).toBe(0); expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  await page.getByLabel('Token', {exact: true}).fill('local-admin-token'); await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Beef Caldereta', exact: true})).toBeVisible(); await expect(page.getByText('No recipe yet.', {exact: true})).toBeVisible(); expect(puts).toBe(1);
});
