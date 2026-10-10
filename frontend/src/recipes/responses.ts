import type {Estimate, Recipe} from './types';
import {scaledQuantity, validQuantity} from '../inventory/model';
import {formatCalendarDate} from '../lib/format';
function invalidRecipe(): never {throw new Error('The server returned an invalid recipe response.');}
function invalidEstimate(): never {throw new Error('The server returned an invalid estimate response.');}
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const money = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const instant = (value: unknown) => text(value) && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const date = (value: unknown) => {try {return text(value) && Boolean(formatCalendarDate(value));} catch {return false;}};
const cost = (value: unknown) => typeof value === 'string' && /^(?:0|[1-9]\d*)\.\d{9}$/.test(value) && value.length <= 40;
const compatible = (base: unknown) => base === 'g' ? ['g', 'kg'] : base === 'ml' ? ['ml', 'l'] : base === 'piece' ? ['piece'] : [];
const amount = (value: unknown, unit: string) => validQuantity(value, unit === 'piece' ? 'piece' : 'g') && scaledQuantity(value) > 0n;

export function checkedRecipe(value: unknown): Recipe {
  const recipe = value as Recipe;
  if (!recipe || !text(recipe.id) || !positive(recipe.version) || !text(recipe.variant_id) || !instant(recipe.recorded_at) || !instant(recipe.updated_at)
    || recipe.yield?.quantity !== 1 || !['tray', 'piece', 'stick', 'package'].includes(recipe.yield.selling_unit)
    || (recipe.yield.selling_unit === 'package' ? !positive(recipe.yield.package_contents?.quantity) || recipe.yield.package_contents?.unit !== 'piece' : recipe.yield.package_contents !== null)
    || !Array.isArray(recipe.items) || !recipe.items.length || new Set(recipe.items.map(item => item?.ingredient_id)).size !== recipe.items.length
    || recipe.items.some(item => !item || !text(item.ingredient_id) || !text(item.ingredient_name) || !compatible(item.base_unit).includes(item.unit) || !amount(item.quantity, item.unit))) invalidRecipe();
  return recipe;
}
export function checkedEstimate(value: unknown): Estimate {
  const estimate = value as Estimate;
  if (!estimate || !text(estimate.variant_id) || (estimate.recipe_version !== null && !positive(estimate.recipe_version)) || !/^[A-Z]{3}$/.test(estimate.currency)
    || !money(estimate.selling_price_minor) || typeof estimate.complete !== 'boolean' || !Array.isArray(estimate.missing) || !Array.isArray(estimate.basis) || !instant(estimate.calculated_at)
    || estimate.complete !== (estimate.missing.length === 0) || new Set(estimate.basis.map(row => row?.ingredient_id)).size !== estimate.basis.length) invalidEstimate();
  const unpriced = new Set<string>();
  for (const row of estimate.basis) {
    if (!row || !text(row.ingredient_id) || !text(row.ingredient_name) || !compatible(row.base_unit).length || !validQuantity(row.base_quantity, row.base_unit) || scaledQuantity(row.base_quantity) <= 0n) invalidEstimate();
    // A row is priced from exactly one receipt line or wholly unknown; never a mixture or a silent zero.
    if (row.purchase_id === null) {if (row.purchase_line_id !== null || row.purchased_on !== null || row.unit_cost !== null || row.estimated_cost !== null) invalidEstimate(); unpriced.add(row.ingredient_id);}
    else if (!text(row.purchase_id) || !text(row.purchase_line_id) || !date(row.purchased_on) || !cost(row.unit_cost) || !cost(row.estimated_cost)) invalidEstimate();
  }
  const priceless = estimate.missing.filter(item => item?.code === 'price_missing');
  if (estimate.missing.some(item => !item || !['recipe_missing', 'price_missing'].includes(item.code) || item.variant_id !== estimate.variant_id || (item.code === 'recipe_missing' ? item.ingredient_id !== null : !text(item.ingredient_id)))
    || priceless.length !== unpriced.size || priceless.some(item => !unpriced.has(item.ingredient_id!))) invalidEstimate();
  if (estimate.complete ? estimate.recipe_version === null || !estimate.basis.length || !money(estimate.ingredient_cost_minor) || !Number.isSafeInteger(estimate.ingredient_contribution_minor)
      || estimate.ingredient_contribution_minor !== estimate.selling_price_minor - estimate.ingredient_cost_minor!
    : estimate.ingredient_cost_minor !== null || estimate.ingredient_contribution_minor !== null) invalidEstimate();
  return estimate;
}
