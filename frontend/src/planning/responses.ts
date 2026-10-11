import type {Planning, ShoppingList} from './types';
import {scaledQuantity, validQuantity} from '../inventory/model';
import {formatCalendarDate} from '../lib/format';
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const instant = (value: unknown) => text(value) && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const date = (value: unknown) => {try {return text(value) && Boolean(formatCalendarDate(value));} catch {return false;}};
const timezone = (value: unknown) => {try {return text(value) && Boolean(new Intl.DateTimeFormat('en', {timeZone: value}));} catch {return false;}};
const most = (a: bigint, b: bigint) => a > b ? a : b;
// What the plan and the shopping list share: identity, period, and a completeness flag that matches the missing recipes.
function calculation(plan: Pick<Planning, 'id' | 'calculated_at' | 'timezone' | 'period' | 'complete' | 'missing'> | null | undefined, fail: () => never) {
  if (!plan || !text(plan.id) || !instant(plan.calculated_at) || !timezone(plan.timezone) || !date(plan.period?.date_from) || !date(plan.period?.date_to) || plan.period.date_from > plan.period.date_to
    || typeof plan.complete !== 'boolean' || !Array.isArray(plan.missing) || plan.complete !== (plan.missing.length === 0) || new Set(plan.missing.map(gap => gap?.variant_id)).size !== plan.missing.length) fail();
  for (const gap of plan.missing) {
    if (!gap || gap.code !== 'recipe_missing' || !text(gap.variant_id) || !text(gap.food_id) || !text(gap.food_name) || !text(gap.variant_label)
      || !Array.isArray(gap.orders) || !gap.orders.length || gap.orders.some(row => !text(row?.order_id) || !text(row?.reference))) fail();
  }
}

export function checkedPlanning(value: unknown): Planning {
  const fail = (): never => {throw new Error('The server returned an invalid planning response.');};
  const plan = value as Planning, action = plan?.permitted_actions?.record_preparation;
  calculation(plan, fail);
  if (!Array.isArray(plan.foods) || !Array.isArray(plan.ingredients) || !action || typeof action.allowed !== 'boolean' || !action.allowed && (!text(action.reason) || !text(action.reason_code))) fail();
  const formats = new Set<string>();
  for (const food of plan.foods) {
    if (!food || !text(food.variant_id) || !text(food.food_name) || !text(food.variant_label) || !['tray', 'piece', 'stick', 'package'].includes(food.selling_unit)
      || (food.selling_unit === 'package' ? !count(food.package_contents?.quantity) || food.package_contents.quantity < 1 || food.package_contents.unit !== 'piece' : food.package_contents !== null)
      || !Array.isArray(food.orders) || !food.orders.length || new Set(food.orders.map(row => row?.order_item_id)).size !== food.orders.length) fail();
    const format = `${food.variant_id}/${food.selling_unit}/${food.package_contents?.quantity ?? ''}`; if (formats.has(format)) fail(); formats.add(format);
    let ordered = 0, prepared = 0;
    for (const row of food.orders) {
      // Only orders that can still be cooked are demand, and what remains is exactly what has not been prepared.
      if (!row || !text(row.order_id) || !count(row.order_version) || row.order_version < 1 || !text(row.reference) || !text(row.order_item_id) || !['confirmed', 'preparing', 'ready'].includes(row.status) || !count(row.ordered_quantity) || row.ordered_quantity < 1
        || !count(row.prepared_quantity) || row.prepared_quantity > row.ordered_quantity || row.remaining_quantity !== row.ordered_quantity - row.prepared_quantity) fail();
      ordered += row.ordered_quantity; prepared += row.prepared_quantity;
    }
    if (food.ordered_quantity !== ordered || food.prepared_quantity !== prepared || food.remaining_quantity !== ordered - prepared) fail();
  }
  if (new Set(plan.ingredients.map(row => row?.ingredient_id)).size !== plan.ingredients.length) fail();
  for (const row of plan.ingredients) {
    if (!row || !text(row.ingredient_id) || !text(row.ingredient_name) || !['g', 'ml', 'piece'].includes(row.base_unit) || !validQuantity(row.stock_after_earlier, row.base_unit, true)
      || [row.stock_on_hand, row.earlier_demand, row.period_demand, row.earlier_shortage, row.period_shortage, row.cumulative_shortage].some(quantity => !validQuantity(quantity, row.base_unit))) fail();
    const stock = scaledQuantity(row.stock_on_hand), earlier = scaledQuantity(row.earlier_demand), period = scaledQuantity(row.period_demand), after = stock - earlier;
    // Earlier commitments are subtracted once, and a deficit before the period stays visible as negative stock.
    if (scaledQuantity(row.stock_after_earlier) !== after || scaledQuantity(row.earlier_shortage) !== most(0n, -after)
      || scaledQuantity(row.period_shortage) !== most(0n, period - most(0n, after)) || scaledQuantity(row.cumulative_shortage) !== most(0n, earlier + period - stock)) fail();
  }
  return plan;
}
export function checkedShoppingList(value: unknown): ShoppingList {
  const fail = (): never => {throw new Error('The server returned an invalid shopping list response.');};
  const list = value as ShoppingList;
  calculation(list, fail);
  if (!Array.isArray(list.items) || new Set(list.items.map(row => row?.ingredient_id)).size !== list.items.length) fail();
  for (const row of list.items) {
    if (!row || !text(row.ingredient_id) || !text(row.ingredient_name) || !['g', 'ml', 'piece'].includes(row.base_unit)
      || [row.stock_on_hand, row.earlier_demand, row.period_demand, row.cumulative_shortage].some(quantity => !validQuantity(quantity, row.base_unit))) fail();
    // Every listed row is a real shortage: demand through the period minus physical stock, and never zero.
    const shortage = scaledQuantity(row.earlier_demand) + scaledQuantity(row.period_demand) - scaledQuantity(row.stock_on_hand);
    if (shortage <= 0n || scaledQuantity(row.cumulative_shortage) !== shortage) fail();
  }
  return list;
}
