import {describe, expect, it} from 'vitest';
import {createRecipeFixtures} from '../src/api/recipe-fixtures';
import {conformance, sampleSettings} from './helpers';
import {recipeSeed, yieldOf} from './recipe-helpers';

describe('recipe and estimate development contract', () => {
  it('enables recipes and reports a variant without a recipe as an incomplete estimate, never a zero cost', async () => {
    const {api, variant} = await recipeSeed();
    await expect(api.request('/settings')).resolves.toMatchObject({capabilities: {recipes: true}});
    await expect(api.request(`/variants/${variant.id}/recipe`)).rejects.toMatchObject({status: 404, code: 'not_found'});
    await expect(api.request(`/variants/${variant.id}/estimate`)).resolves.toMatchObject({variant_id: variant.id, recipe_version: null, currency: 'USD', selling_price_minor: 8000,
      ingredient_cost_minor: null, ingredient_contribution_minor: null, complete: false, basis: [], missing: [{code: 'recipe_missing', ingredient_id: null, variant_id: variant.id}]});
    await expect(api.request('/variants/unknown/estimate')).rejects.toMatchObject({status: 404});
  });

  it('creates a one-unit recipe and estimates 750 g of a 2 kg/$24 purchase as $9 against the selling price', async () => {
    const {api, food, variant, flour, purchase, put} = await recipeSeed();
    const recipe = await put([{ingredient_id: flour.id, quantity: '750', unit: 'g'}]);
    expect(recipe).toMatchObject({version: 1, variant_id: variant.id, yield: {quantity: 1, selling_unit: 'tray', package_contents: null},
      items: [{ingredient_id: flour.id, ingredient_name: 'Flour', base_unit: 'g', quantity: '750', unit: 'g'}]});
    await expect(api.request(`/variants/${variant.id}/recipe`)).resolves.toEqual(recipe);
    const saved = await api.request<any>(`/foods/${food.id}`);
    expect(saved.variants.find((item: any) => item.id === variant.id).recipe_id).toBe(recipe.id);
    expect(saved.variants.find((item: any) => item.label === 'Small').recipe_id).toBeNull();
    await expect(api.request(`/variants/${variant.id}/estimate`)).resolves.toMatchObject({recipe_version: 1, selling_price_minor: 8000, ingredient_cost_minor: 900, ingredient_contribution_minor: 7100, complete: true, missing: [],
      basis: [{ingredient_id: flour.id, ingredient_name: 'Flour', base_unit: 'g', base_quantity: '750', purchase_id: purchase.id, purchase_line_id: purchase.items[0].id, purchased_on: '2026-10-07', unit_cost: '0.012000000', estimated_cost: '9.000000000'}]});
  });

  it('normalizes kilograms, litres and whole pieces to base quantities without inferring other sizes', async () => {
    const {api, food, variant, flour, ingredient, buy, put} = await recipeSeed();
    const stock = await ingredient('Stock', 'ml'), egg = await ingredient('Egg', 'piece');
    await buy(stock.id, {quantity: '1', unit: 'l', total_cost_minor: 400}); await buy(egg.id, {quantity: '12', unit: 'piece', total_cost_minor: 600});
    await put([{ingredient_id: flour.id, quantity: '0.75', unit: 'kg'}, {ingredient_id: stock.id, quantity: '0.5', unit: 'l'}, {ingredient_id: egg.id, quantity: '3', unit: 'piece'}]);
    const estimate = await api.request<any>(`/variants/${variant.id}/estimate`);
    expect(estimate.basis.map((row: any) => [row.base_quantity, row.base_unit, row.estimated_cost])).toEqual([['750', 'g', '9.000000000'], ['500', 'ml', '2.000000000'], ['3', 'piece', '1.500000000']]);
    expect(estimate).toMatchObject({ingredient_cost_minor: 1250, ingredient_contribution_minor: 6750, complete: true});
    const small = food.variants.find(item => item.label === 'Small')!;
    await expect(api.request(`/variants/${small.id}/estimate`)).resolves.toMatchObject({complete: false, missing: [{code: 'recipe_missing'}]});
  });

  it('keeps an unknown price incomplete and distinct from a known zero cost', async () => {
    const {api, variant, flour, ingredient, buy, put} = await recipeSeed();
    const salt = await ingredient('Salt');
    await put([{ingredient_id: flour.id, quantity: '750', unit: 'g'}, {ingredient_id: salt.id, quantity: '5', unit: 'g'}]);
    const incomplete = await api.request<any>(`/variants/${variant.id}/estimate`);
    expect(incomplete).toMatchObject({ingredient_cost_minor: null, ingredient_contribution_minor: null, complete: false, missing: [{code: 'price_missing', ingredient_id: salt.id, variant_id: variant.id}]});
    expect(incomplete.basis[1]).toMatchObject({ingredient_id: salt.id, base_quantity: '5', purchase_id: null, purchase_line_id: null, purchased_on: null, unit_cost: null, estimated_cost: null});
    expect(incomplete.basis[0]).toMatchObject({estimated_cost: '9.000000000'});
    await buy(salt.id, {quantity: '1', unit: 'kg', total_cost_minor: 0});
    await expect(api.request(`/variants/${variant.id}/estimate`)).resolves.toMatchObject({ingredient_cost_minor: 900, complete: true, missing: [], basis: [{}, {unit_cost: '0.000000000', estimated_cost: '0.000000000'}]});
  });

  it('rounds the recipe total once, half-up, from the unrounded purchase basis', async () => {
    const {api, variant, ingredient, buy, put} = await recipeSeed();
    const a = await ingredient('Saffron'), b = await ingredient('Vanilla');
    await buy(a.id, {quantity: '3', unit: 'g', total_cost_minor: 1}); await buy(b.id, {quantity: '3', unit: 'g', total_cost_minor: 1});
    await put([{ingredient_id: a.id, quantity: '1.5', unit: 'g'}]);
    await expect(api.request(`/variants/${variant.id}/estimate`)).resolves.toMatchObject({ingredient_cost_minor: 1, basis: [{unit_cost: '0.003333333', estimated_cost: '0.005000000'}]});
    await put([{ingredient_id: a.id, quantity: '1.5', unit: 'g'}, {ingredient_id: b.id, quantity: '1.5', unit: 'g'}], 1);
    await expect(api.request(`/variants/${variant.id}/estimate`)).resolves.toMatchObject({recipe_version: 2, ingredient_cost_minor: 1, ingredient_contribution_minor: 7999});
  });

  it('recomputes from the latest business-date purchase, the saved recipe and the current selling price', async () => {
    const {api, variant, flour, buy, put} = await recipeSeed({recipe: true});
    await buy(flour.id, {quantity: '1', unit: 'kg', total_cost_minor: 5000}, '2026-10-01');
    await expect(api.request(`/variants/${variant.id}/estimate`)).resolves.toMatchObject({ingredient_cost_minor: 900});
    const newer = await buy(flour.id, {quantity: '1', unit: 'kg', total_cost_minor: 2000}, '2026-10-08');
    await expect(api.request(`/variants/${variant.id}/estimate`)).resolves.toMatchObject({ingredient_cost_minor: 1500, basis: [{purchase_id: newer.id, purchased_on: '2026-10-08', unit_cost: '0.020000000'}]});
    await expect(put([{ingredient_id: flour.id, quantity: '500', unit: 'g'}], 1)).resolves.toMatchObject({version: 2});
    await expect(api.request(`/variants/${variant.id}/estimate`)).resolves.toMatchObject({recipe_version: 2, ingredient_cost_minor: 1000, ingredient_contribution_minor: 7000});
    await api.request(`/variants/${variant.id}`, {method: 'PATCH', operationId: crypto.randomUUID(), body: {expected_version: variant.version, price_minor: 9000}});
    await expect(api.request(`/variants/${variant.id}/estimate`)).resolves.toMatchObject({selling_price_minor: 9000, ingredient_cost_minor: 1000, ingredient_contribution_minor: 8000});
  });

  it('rejects invalid recipes at their fields and leaves the saved recipe unchanged', async () => {
    const {api, variant, flour, ingredient, put} = await recipeSeed({recipe: true});
    const egg = await ingredient('Egg', 'piece'), row = {ingredient_id: flour.id, quantity: '750', unit: 'g'};
    const invalid: [unknown[], string][] = [[[], '/items'], [[row, row], '/items/1/ingredient_id'], [[{...row, ingredient_id: 'unknown'}], '/items/0/ingredient_id'], [[{...row, unit: 'ml'}], '/items/0/unit'],
      [[{ingredient_id: egg.id, quantity: '1.5', unit: 'piece'}], '/items/0/quantity'], [[{...row, quantity: '0'}], '/items/0/quantity'], [[{...row, quantity: '1.0001'}], '/items/0/quantity'], [[{...row, note: 'x'}], '/items/0/note']];
    for (const [items, path] of invalid) await expect(put(items as any, 1), path).rejects.toMatchObject({status: 422, code: 'validation_failed', fieldErrors: [{path}]});
    const body = {expected_version: 1, yield: yieldOf(variant), items: [row]};
    await expect(api.request(`/variants/${variant.id}/recipe`, {method: 'PUT', body: {...body, yield: {...body.yield, quantity: 2}}})).rejects.toMatchObject({status: 422, fieldErrors: [{path: '/yield'}]});
    await expect(api.request(`/variants/${variant.id}/recipe`, {method: 'PUT', body: {...body, yield: {quantity: 1, selling_unit: 'piece', package_contents: null}}})).rejects.toMatchObject({status: 422, fieldErrors: [{path: '/yield'}]});
    await expect(api.request(`/variants/${variant.id}/recipe`, {method: 'PUT', body: {...body, unexpected: true}})).rejects.toMatchObject({status: 422, fieldErrors: [{path: '/unexpected'}]});
    await expect(api.request(`/variants/${variant.id}/recipe`)).resolves.toMatchObject({version: 1, items: [{quantity: '750', unit: 'g'}]});
  });

  it('requires a null version only when creating and returns the latest recipe for a stale or raced save', async () => {
    const {api, variant, flour, put} = await recipeSeed();
    const items = [{ingredient_id: flour.id, quantity: '750', unit: 'g'}];
    await expect(put(items, 1)).rejects.toMatchObject({status: 422, fieldErrors: [{path: '/expected_version'}]});
    const recipe = await put(items);
    const conflict = {status: 409, code: 'version_conflict', details: {resource_type: 'recipe', resource_id: recipe.id, current_version: 1, latest_resource: recipe}};
    await expect(put(items)).rejects.toMatchObject({...conflict, details: {...conflict.details, expected_version: null}});
    await expect(put(items, 2)).rejects.toMatchObject({...conflict, details: {...conflict.details, expected_version: 2}});
    await expect(api.request(`/variants/${variant.id}/recipe`)).resolves.toEqual(recipe);
  });

  it('treats a recipe written for another selling format as missing until it is saved for the current one', async () => {
    const {api, variant, flour, put} = await recipeSeed({recipe: true});
    const changed = await api.request<any>(`/variants/${variant.id}`, {method: 'PATCH', operationId: crypto.randomUUID(), body: {expected_version: variant.version, selling_unit: 'package', package_contents: {quantity: 10, unit: 'piece'}}});
    await expect(api.request(`/variants/${variant.id}/estimate`)).resolves.toMatchObject({recipe_version: 1, complete: false, ingredient_cost_minor: null, missing: [{code: 'recipe_missing', ingredient_id: null}]});
    const items = [{ingredient_id: flour.id, quantity: '750', unit: 'g'}];
    await expect(put(items, 1)).rejects.toMatchObject({status: 422, fieldErrors: [{path: '/yield'}]});
    await expect(put(items, 1, changed)).resolves.toMatchObject({version: 2, yield: {quantity: 1, selling_unit: 'package', package_contents: {quantity: 10, unit: 'piece'}}});
    await expect(api.request(`/variants/${variant.id}/estimate`)).resolves.toMatchObject({recipe_version: 2, complete: true, ingredient_cost_minor: 900});
  });

  it.skipIf(conformance)('answers only recipe routes and refuses them without the recipes and inventory capabilities', async () => {
    const closed = async () => null;
    const handler = createRecipeFixtures({menu: closed, inventory: closed, settings: sampleSettings, recipeIds: new Map()});
    expect(await handler(new URL('http://fixture/api/v1/variants/variant1'))).toBeNull();
    expect(await handler(new URL('http://fixture/api/v1/foods'))).toBeNull();
    expect((await handler(new URL('http://fixture/api/v1/variants/variant1/estimate')))!.status).toBe(403);
    const inventoryOff = createRecipeFixtures({menu: closed, inventory: closed, settings: {...sampleSettings, capabilities: {...sampleSettings.capabilities, recipes: true}}, recipeIds: new Map()});
    expect((await inventoryOff(new URL('http://fixture/api/v1/variants/variant1/recipe')))!.status).toBe(403);
  });
});
