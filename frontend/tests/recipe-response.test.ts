import {describe, expect, it} from 'vitest';
import {preciseAmount} from '../src/inventory/model';
import {sameItems, sameYield} from '../src/recipes/model';
import {checkedEstimate, checkedRecipe} from '../src/recipes/responses';
import {recipeSeed} from './recipe-helpers';

const copy = <T,>(value: T, change: (draft: any) => void): T => {const draft = structuredClone(value); change(draft); return draft;};
async function examples() {
  const seed = await recipeSeed({recipe: true}), {api, food, variant, flour, ingredient, put} = seed;
  const recipe = await api.request<any>(`/variants/${variant.id}/recipe`), complete = await api.request<any>(`/variants/${variant.id}/estimate`);
  const missing = await api.request<any>(`/variants/${food.variants.find(item => item.label === 'Small')!.id}/estimate`);
  const salt = await ingredient('Salt'); await put([{ingredient_id: flour.id, quantity: '750', unit: 'g'}, {ingredient_id: salt.id, quantity: '5', unit: 'g'}], 1);
  return {recipe, complete, missing, incomplete: await api.request<any>(`/variants/${variant.id}/estimate`)};
}

describe('recipe and estimate response boundary', () => {
  it('accepts the development recipe and its complete, unpriced and recipe-less estimates', async () => {
    const {recipe, complete, missing, incomplete} = await examples();
    expect(checkedRecipe(recipe)).toBe(recipe);
    for (const estimate of [complete, missing, incomplete]) expect(checkedEstimate(estimate)).toBe(estimate);
    expect(checkedRecipe(copy(recipe, draft => {draft.yield = {quantity: 1, selling_unit: 'package', package_contents: {quantity: 100, unit: 'piece'}}; draft.items[0].quantity = '0.75'; draft.items[0].unit = 'kg';}))).toBeTruthy();
    expect(checkedEstimate(copy(complete, draft => {draft.selling_price_minor = 500; draft.ingredient_contribution_minor = -400;}))).toBeTruthy();
  });

  it('rejects recipes with an invalid identity, yield, ingredient list, unit or quantity', async () => {
    const {recipe} = await examples();
    const invalid: ((draft: any) => void)[] = [draft => {draft.id = '';}, draft => {draft.version = 0;}, draft => {draft.variant_id = null;}, draft => {draft.yield.quantity = 2;},
      draft => {draft.yield.selling_unit = 'box';}, draft => {draft.yield.package_contents = {quantity: 10, unit: 'piece'};}, draft => {draft.yield = {quantity: 1, selling_unit: 'package', package_contents: null};},
      draft => {draft.items = [];}, draft => {draft.items.push(draft.items[0]);}, draft => {draft.items[0].ingredient_name = '';}, draft => {draft.items[0].base_unit = 'kg';},
      draft => {draft.items[0].unit = 'ml';}, draft => {draft.items[0].quantity = '0';}, draft => {draft.items[0].quantity = '1.0001';}, draft => {draft.items[0].quantity = 750;},
      draft => {draft.items[0] = {...draft.items[0], base_unit: 'piece', unit: 'piece', quantity: '1.5'};}, draft => {draft.updated_at = '2026-10-07';}];
    for (const [index, change] of invalid.entries()) expect(() => checkedRecipe(copy(recipe, change)), `case ${index}`).toThrow('The server returned an invalid recipe response.');
    expect(() => checkedRecipe(null)).toThrow();
  });

  it('rejects estimates that disagree with their own totals, missing list or cost basis', async () => {
    const {complete, missing, incomplete} = await examples();
    const invalid: [any, (draft: any) => void][] = [
      [complete, draft => {draft.ingredient_cost_minor = null;}], [complete, draft => {draft.ingredient_contribution_minor = 7000;}], [complete, draft => {draft.complete = false;}],
      [complete, draft => {draft.basis = [];}], [complete, draft => {draft.recipe_version = null;}], [complete, draft => {draft.basis[0].estimated_cost = null;}],
      [complete, draft => {draft.basis[0].unit_cost = '0.012';}], [complete, draft => {draft.basis[0].purchased_on = '2026-02-30';}], [complete, draft => {draft.basis[0].base_quantity = '0';}],
      [complete, draft => {draft.currency = 'usd';}], [complete, draft => {draft.calculated_at = 'yesterday';}], [complete, draft => {draft.selling_price_minor = -1;}],
      [complete, draft => {draft.missing = [{code: 'price_missing', ingredient_id: draft.basis[0].ingredient_id, variant_id: draft.variant_id}];}],
      [incomplete, draft => {draft.ingredient_cost_minor = 0; draft.ingredient_contribution_minor = draft.selling_price_minor;}], [incomplete, draft => {draft.complete = true;}],
      [incomplete, draft => {draft.missing = [];}], [incomplete, draft => {draft.missing[0].ingredient_id = 'another-ingredient';}], [incomplete, draft => {draft.missing[0].variant_id = 'another-variant';}],
      [incomplete, draft => {draft.basis[1].unit_cost = '0.000000000';}], [incomplete, draft => {draft.missing[0].code = 'unknown';}],
      [missing, draft => {draft.missing[0].ingredient_id = 'ingredient';}], [missing, draft => {draft.ingredient_cost_minor = 0;}],
    ];
    for (const [index, [estimate, change]] of invalid.entries()) expect(() => checkedEstimate(copy(estimate, change)), `case ${index}`).toThrow('The server returned an invalid estimate response.');
    expect(() => checkedEstimate(undefined)).toThrow();
  });

  it('formats exact estimated amounts and compares saved recipe rows by value', () => {
    expect(preciseAmount('9.000000000', 'USD')).toBe('$9.00');
    expect(preciseAmount('0.005000000', 'USD')).toBe('$0.005');
    expect(preciseAmount('1234.500000000', 'USD')).toBe('$1,234.50');
    expect(preciseAmount('0.000000000', 'USD')).toBe('$0.00');
    const row = {ingredient_id: 'flour', quantity: '0.75', unit: 'kg' as const};
    expect(sameItems([row], [{...row, quantity: '0.750'}])).toBe(true);
    for (const other of [[{...row, quantity: '0.751'}], [{...row, unit: 'g' as const}], [{...row, ingredient_id: 'salt'}], [row, {...row, ingredient_id: 'salt'}], []]) expect(sameItems([row], other)).toBe(false);
    const tray = {quantity: 1 as const, selling_unit: 'tray' as const, package_contents: null};
    expect(sameYield(tray, {...tray})).toBe(true);
    expect(sameYield(tray, {...tray, selling_unit: 'piece'})).toBe(false);
    expect(sameYield({quantity: 1, selling_unit: 'package', package_contents: {quantity: 100, unit: 'piece'}}, {quantity: 1, selling_unit: 'package', package_contents: {quantity: 50, unit: 'piece'}})).toBe(false);
  });
});
