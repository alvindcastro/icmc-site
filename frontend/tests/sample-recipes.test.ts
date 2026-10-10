import {describe, expect, it} from 'vitest';
import {createApiClient} from '../src/api/client';
import {createFixtureTransport} from '../src/api/fixtures';
import type {Food, PageResult} from '../src/api/types';
import {checkedIngredient, checkedPurchase} from '../src/inventory/responses';
import {checkedEstimate, checkedRecipe} from '../src/recipes/responses';
import {yieldOf} from './recipe-helpers';

async function api(samples?: boolean) {
  const client = createApiClient({baseUrl: '/api/v1', transport: createFixtureTransport({latency: 0, samples}).fetch});
  const session = await client.request<{csrf_token: string}>('/auth/sign-in', {method: 'POST', body: {username: 'admin', token: 'local-admin-token'}}); client.setCsrfToken(session.csrf_token);
  return client;
}
const variants = async (client: Awaited<ReturnType<typeof api>>) => (await client.request<PageResult<Food>>('/foods?limit=100')).items.flatMap(food => food.variants.map(variant => ({food, variant})));

describe('placeholder development recipes', () => {
  it('stay out of the default fixture, which starts with no ingredients, purchases or recipes', async () => {
    const client = await api();
    await expect(client.request('/ingredients')).resolves.toMatchObject({total: 0}); await expect(client.request('/purchases')).resolves.toMatchObject({total: 0});
    expect((await variants(client)).every(({variant}) => variant.recipe_id === null)).toBe(true);
  });

  it('seed lorem ipsum ingredients priced by one placeholder receipt when samples are requested', async () => {
    const client = await api(true), ingredients = await client.request<any>('/ingredients');
    expect(ingredients.items.map((item: any) => [item.name, item.base_unit, item.stock_on_hand])).toEqual([['Amet', 'piece', '12'], ['Dolor', 'ml', '1000'], ['Ipsum', 'g', '1000'], ['Lorem', 'g', '2000']]);
    for (const item of ingredients.items) {checkedIngredient(item); expect(item).toMatchObject({latest_purchase_date: '2026-10-01', low_stock: false, low_stock_threshold: null});}
    const purchases = await client.request<any>('/purchases');
    expect(purchases).toMatchObject({total: 1, items: [{reference: 'DEV-P0001', supplier: 'Lorem ipsum supplier', purchased_on: '2026-10-01', total_cost_minor: 4200}]});
    expect(checkedPurchase(await client.request(`/purchases/${purchases.items[0].id}`)).items).toHaveLength(4);
  });

  it('give every provisional variant its own one-unit placeholder recipe and a complete estimate', async () => {
    const client = await api(true), all = await variants(client), estimates: Record<string, [number, number]> = {};
    expect(all).toHaveLength(6);
    for (const {food, variant} of all) {
      const recipe = checkedRecipe(await client.request(`/variants/${variant.id}/recipe`));
      expect(variant.recipe_id).toBe(recipe.id); expect(recipe.yield).toEqual(yieldOf(variant));
      expect(recipe.items.every(item => ['Lorem', 'Ipsum', 'Dolor', 'Amet'].includes(item.ingredient_name))).toBe(true);
      const estimate = checkedEstimate(await client.request(`/variants/${variant.id}/estimate`)); expect(estimate.complete).toBe(true);
      estimates[`${food.name}/${variant.label}`] = [estimate.ingredient_cost_minor!, estimate.ingredient_contribution_minor!];
    }
    expect(estimates).toEqual({'Beef Caldereta/Small': [640, 5360], 'Beef Caldereta/Medium': [960, 7040], 'Beef Caldereta/Large': [1280, 9220],
      'Fresh Lumpia/Each': [82, 218], 'Shanghai Spring Rolls/100 pieces': [1020, 4480], 'Development skewers/Each stick': [48, 102]});
  });

  it('leave a placeholder recipe replaceable by an entered one', async () => {
    const client = await api(true), medium = (await variants(client)).find(({variant}) => variant.label === 'Medium')!.variant;
    const lorem = (await client.request<any>('/ingredients?q=lorem')).items[0];
    await expect(client.request(`/variants/${medium.id}/recipe`, {method: 'PUT', body: {expected_version: 1, yield: yieldOf(medium), items: [{ingredient_id: lorem.id, quantity: '500', unit: 'g'}]}})).resolves.toMatchObject({version: 2});
    await expect(client.request(`/variants/${medium.id}/estimate`)).resolves.toMatchObject({recipe_version: 2, ingredient_cost_minor: 600, complete: true});
  });
});
