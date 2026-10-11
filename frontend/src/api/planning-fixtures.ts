import Decimal from 'decimal.js';
import type {BusinessSettings, Food, PageResult} from './types';
import {canonicalFixture as canonical} from './fixture-protocol';
import type {Ingredient} from '../inventory/types';
import {formatCalendarDate} from '../lib/format';
import type {Order, OrderSummary} from '../orders/types';
import type {Planning, PlanningFood, PlanningIngredient, PlanningMissing, ShoppingList} from '../planning/types';
import type {Recipe} from '../recipes/types';

const D = Decimal.clone({precision: 60});
type Handler = (url: URL, init?: RequestInit) => Promise<Response | null>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const date = (value: string | null): value is string => {try {return value !== null && Boolean(formatCalendarDate(value));} catch {return false;}};
const days = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;

export function createPlanningFixtures({orders, menu, recipes, inventory, settings}: {orders: Handler; menu: Handler; recipes: Handler; inventory: Handler; settings: BusinessSettings}): Handler {
  // Orders, menu, recipes and stock are read through their own fixture handlers; planning never writes anything.
  async function read<T>(handler: Handler, path: string): Promise<T | null> {
    const response = await handler(new URL(`http://fixture.local/api/v1${path}`)); return response?.ok ? await response.json() as T : null;
  }
  async function pages<T>(handler: Handler, path: string): Promise<T[]> {
    const found: T[] = [];
    for (let page = 1; ; page++) {
      const result = await read<PageResult<T>>(handler, `${path}${path.includes('?') ? '&' : '?'}limit=100&page=${page}`); if (!result) return found;
      found.push(...result.items); if (!result.has_next) return found;
    }
  }
  return async url => {
    const path = url.pathname.replace('/api/v1', '');
    if (path !== '/planning' && path !== '/planning/shopping-list') return null;
    const fail = (status: number, code: string, message: string) => json({error: {code, message, field_errors: [], details: {}, request_id: 'planning-development-fixture'}}, status);
    if (!settings.capabilities.planning || !settings.capabilities.orders) return fail(403, 'forbidden', 'Planning workflow unavailable.');
    let from = url.searchParams.get('date_from'), to = url.searchParams.get('date_to');
    if (from === null && to === null) from = to = (await read<{business_date: string}>(orders, '/dashboard'))!.business_date;
    if (!date(from) || !date(to) || from > to || days(from, to) > 366 || [...url.searchParams.keys()].some(key => !['date_from', 'date_to'].includes(key))) {
      return fail(422, 'validation_failed', 'Choose a planning period of at most 366 days.');
    }
    // Remaining quantities of Confirmed, Preparing and Ready orders are demand; everything before the period is an earlier commitment.
    const summaries = await pages<OrderSummary>(orders, `/orders?status=confirmed,preparing,ready&date_to=${to}`), active: Order[] = [];
    for (const summary of summaries) {const order = await read<Order>(orders, `/orders/${encodeURIComponent(summary.id)}`); if (order) active.push(order);}
    active.sort((a, b) => a.fulfillment.fulfillment_at.localeCompare(b.fulfillment.fulfillment_at) || a.reference.localeCompare(b.reference));
    const foodIds = new Map((await pages<Food>(menu, '/foods')).flatMap(food => food.variants.map(variant => [variant.id, food.id] as const)));
    const rows = new Map<string, PlanningFood>(), gaps = new Map<string, PlanningMissing>(), needs = new Map<string, {earlier: Decimal; period: Decimal}>();
    for (const order of active) {
      const within = order.fulfillment.local_date >= from;
      for (const item of order.items) {
        const prepared = item.prepared_quantity ?? 0, remaining = item.quantity - prepared, format = {quantity: 1, selling_unit: item.selling_unit, package_contents: item.package_contents};
        if (within) {
          // A variant sold in two formats is two rows; unlike quantities are never merged.
          const key = canonical([item.variant_id, format]);
          const row = rows.get(key) ?? {variant_id: item.variant_id, food_name: item.food_name, variant_label: item.variant_label, selling_unit: item.selling_unit, package_contents: item.package_contents,
            ordered_quantity: 0, prepared_quantity: 0, remaining_quantity: 0, orders: []};
          row.ordered_quantity += item.quantity; row.prepared_quantity += prepared; row.remaining_quantity += remaining;
          row.orders.push({order_id: order.id, order_version: order.version, reference: order.reference, order_item_id: item.id, status: order.status, ordered_quantity: item.quantity, prepared_quantity: prepared, remaining_quantity: remaining});
          rows.set(key, row);
        }
        if (remaining <= 0) continue;
        const recipe = await read<Recipe>(recipes, `/variants/${encodeURIComponent(item.variant_id)}/recipe`);
        if (!recipe || canonical(recipe.yield) !== canonical(format)) {
          const gap = gaps.get(item.variant_id) ?? {code: 'recipe_missing', variant_id: item.variant_id, food_id: foodIds.get(item.variant_id) ?? '', food_name: item.food_name, variant_label: item.variant_label, orders: []};
          if (!gap.orders.some(row => row.order_id === order.id)) gap.orders.push({order_id: order.id, reference: order.reference});
          gaps.set(item.variant_id, gap); continue;
        }
        for (const row of recipe.items) {
          const need = needs.get(row.ingredient_id) ?? {earlier: new D(0), period: new D(0)}, amount = new D(row.quantity).times(['kg', 'l'].includes(row.unit) ? 1000 : 1).times(remaining);
          needs.set(row.ingredient_id, within ? {...need, period: need.period.plus(amount)} : {...need, earlier: need.earlier.plus(amount)});
        }
      }
    }
    const ingredients: PlanningIngredient[] = [];
    for (const [id, {earlier, period}] of needs) {
      const item = await read<Ingredient>(inventory, `/ingredients/${encodeURIComponent(id)}`); if (!item) continue;
      const stock = new D(item.stock_on_hand), after = stock.minus(earlier), zero = new D(0);
      ingredients.push({ingredient_id: id, ingredient_name: item.name, base_unit: item.base_unit, stock_on_hand: stock.toFixed(), earlier_demand: earlier.toFixed(), period_demand: period.toFixed(),
        stock_after_earlier: after.toFixed(), earlier_shortage: D.max(zero, earlier.minus(stock)).toFixed(), period_shortage: D.max(zero, period.minus(D.max(zero, after))).toFixed(),
        cumulative_shortage: D.max(zero, earlier.plus(period).minus(stock)).toFixed()});
    }
    const blocked = {allowed: false, reason_code: 'preparation_recording_disabled', reason: 'Preparation recording is not enabled.'};
    const plan: Planning = {id: `fixture_planning_${crypto.randomUUID()}`, calculated_at: new Date().toISOString(), timezone: settings.timezone, period: {date_from: from, date_to: to},
      complete: gaps.size === 0, missing: [...gaps.values()].sort((a, b) => a.food_name.localeCompare(b.food_name) || a.variant_label.localeCompare(b.variant_label)),
      foods: [...rows.values()].sort((a, b) => a.food_name.localeCompare(b.food_name) || a.variant_label.localeCompare(b.variant_label)),
      ingredients: ingredients.sort((a, b) => a.ingredient_name.localeCompare(b.ingredient_name) || a.ingredient_id.localeCompare(b.ingredient_id)),
      permitted_actions: {record_preparation: settings.capabilities.preparation_recording ? {allowed: true, reason_code: null, reason: null} : blocked}};
    if (path === '/planning') return json(plan);
    // The shopping list is the same calculation, reduced to what stock cannot cover through the period.
    const list: ShoppingList = {id: plan.id, calculated_at: plan.calculated_at, timezone: plan.timezone, period: plan.period, complete: plan.complete, missing: plan.missing,
      items: plan.ingredients.filter(row => new D(row.cumulative_shortage).gt(0)).map(({ingredient_id, ingredient_name, base_unit, stock_on_hand, earlier_demand, period_demand, cumulative_shortage}) =>
        ({ingredient_id, ingredient_name, base_unit, stock_on_hand, earlier_demand, period_demand, cumulative_shortage}))};
    return json(list);
  };
}
