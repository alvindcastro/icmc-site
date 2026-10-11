import {describe, expect, it} from 'vitest';
import {createPlanningFixtures} from '../src/api/planning-fixtures';
import {conformance, sampleSettings} from './helpers';
import {planningSeed} from './planning-helpers';

describe('planning development contract', () => {
  it('reports the remaining demand of the selected period with its contributing orders and ingredient needs', async () => {
    const {api, medium, flour, order, planning} = await planningSeed(), saved = await order('2026-10-10', [[medium, 2]]);
    await expect(api.request('/settings')).resolves.toMatchObject({capabilities: {planning: true, preparation_recording: false}});
    const plan = await planning('2026-10-10');
    expect(plan).toMatchObject({timezone: 'America/Los_Angeles', period: {date_from: '2026-10-10', date_to: '2026-10-10'}, complete: true, missing: [],
      foods: [{variant_id: medium.id, food_name: 'Beef Caldereta', variant_label: 'Medium', selling_unit: 'tray', package_contents: null, ordered_quantity: 2, prepared_quantity: 0, remaining_quantity: 2,
        orders: [{order_id: saved.id, order_version: 1, reference: saved.reference, order_item_id: saved.items[0].id, status: 'confirmed', ordered_quantity: 2, prepared_quantity: 0, remaining_quantity: 2}]}],
      ingredients: [{ingredient_id: flour.id, ingredient_name: 'Flour', base_unit: 'g', stock_on_hand: '2000', earlier_demand: '0', period_demand: '1500',
        stock_after_earlier: '2000', earlier_shortage: '0', period_shortage: '0', cumulative_shortage: '0'}],
      permitted_actions: {record_preparation: {allowed: false}}});
    expect(typeof plan.id).toBe('string'); expect(Date.parse(plan.calculated_at)).not.toBeNaN();
    await expect(api.request(`/ingredients/${flour.id}`)).resolves.toMatchObject({stock_on_hand: '2000', version: 2});
  });

  it('keeps Confirmed, Preparing and Ready demand and leaves out Pending, Completed and Cancelled orders', async () => {
    const {medium, order, advance, cancel, planning} = await planningSeed(), day = '2026-10-10';
    const confirmed = await order(day, [[medium, 1]]), preparing = await advance(await order(day, [[medium, 1]]), 'preparing'), ready = await advance(await order(day, [[medium, 1]]), 'preparing', 'ready');
    await order(day, [[medium, 1]], 'pending'); await advance(await order(day, [[medium, 1]]), 'preparing', 'ready', 'completed'); await cancel(await order(day, [[medium, 1]]));
    const plan = await planning(day);
    expect(plan.foods).toHaveLength(1); expect(plan.foods[0]).toMatchObject({ordered_quantity: 3, prepared_quantity: 0, remaining_quantity: 3});
    expect(plan.foods[0].orders.map((row: any) => [row.order_id, row.status, row.order_version])).toEqual([[confirmed.id, 'confirmed', 1], [preparing.id, 'preparing', 2], [ready.id, 'ready', 3]]);
    expect(plan.ingredients[0]).toMatchObject({period_demand: '2250', period_shortage: '250', cumulative_shortage: '250'});
  });

  it('counts earlier outstanding commitments once, keeping a negative stock after them visible', async () => {
    const {medium, order, planning} = await planningSeed();
    await order('2026-10-08', [[medium, 2]]); await order('2026-10-10', [[medium, 1]]);
    const within = await planning('2026-10-10');
    expect(within.foods).toMatchObject([{ordered_quantity: 1, remaining_quantity: 1}]); expect(within.foods[0].orders).toHaveLength(1);
    expect(within.ingredients[0]).toMatchObject({stock_on_hand: '2000', earlier_demand: '1500', period_demand: '750', stock_after_earlier: '500', earlier_shortage: '0', period_shortage: '250', cumulative_shortage: '250'});
    await order('2026-10-09', [[medium, 1]]);
    await expect(planning('2026-10-10')).resolves.toMatchObject({ingredients: [{earlier_demand: '2250', period_demand: '750', stock_after_earlier: '-250', earlier_shortage: '250', period_shortage: '750', cumulative_shortage: '1000'}]});
    await expect(planning('2026-10-08', '2026-10-10')).resolves.toMatchObject({foods: [{ordered_quantity: 4, remaining_quantity: 4}],
      ingredients: [{earlier_demand: '0', period_demand: '3000', stock_after_earlier: '2000', earlier_shortage: '0', period_shortage: '1000', cumulative_shortage: '1000'}]});
    await expect(planning('2026-10-11')).resolves.toMatchObject({foods: [], complete: true, ingredients: [{earlier_demand: '3000', period_demand: '0', stock_after_earlier: '-1000', earlier_shortage: '1000', period_shortage: '0', cumulative_shortage: '1000'}]});
  });

  it('marks demand without a recipe incomplete, in the period or before it, and names the variant and orders', async () => {
    const {food, medium, small, order, planning} = await planningSeed();
    const mixed = await order('2026-10-10', [[medium, 1], [small, 2]]);
    const plan = await planning('2026-10-10');
    expect(plan).toMatchObject({complete: false, missing: [{code: 'recipe_missing', variant_id: small.id, food_id: food.id, food_name: 'Beef Caldereta', variant_label: 'Small', orders: [{order_id: mixed.id, reference: mixed.reference}]}]});
    expect(plan.foods.map((row: any) => [row.variant_label, row.remaining_quantity])).toEqual([['Medium', 1], ['Small', 2]]);
    expect(plan.ingredients).toMatchObject([{ingredient_name: 'Flour', period_demand: '750'}]);
    await expect(planning('2026-10-12')).resolves.toMatchObject({complete: false, foods: [], missing: [{variant_id: small.id, orders: [{order_id: mixed.id}]}], ingredients: [{earlier_demand: '750', period_demand: '0'}]});
    await expect(planning('2026-10-09')).resolves.toMatchObject({complete: true, missing: [], foods: [], ingredients: []});
  });

  it('defaults to the business date and rejects an invalid or oversized period', async () => {
    const {api} = await planningSeed(), today = (await api.request<any>('/dashboard')).business_date;
    await expect(api.request('/planning')).resolves.toMatchObject({period: {date_from: today, date_to: today}, complete: true, foods: [], ingredients: []});
    for (const query of ['date_from=2026-10-10', 'date_to=2026-10-10', 'date_from=2026-10-11&date_to=2026-10-10', 'date_from=2026-02-30&date_to=2026-03-01', 'date_from=2026-01-01&date_to=2027-01-02', 'date_from=2026-10-10&date_to=2026-10-10&page=2']) {
      await expect(api.request(`/planning?${query}`), query).rejects.toMatchObject({status: 422, code: 'validation_failed'});
    }
    await expect(api.request('/planning?date_from=2026-01-01&date_to=2027-01-01')).resolves.toMatchObject({period: {date_from: '2026-01-01', date_to: '2027-01-01'}});
  });

  it('lists only ingredients with a cumulative shortage to buy, with the plan\'s period, completeness and commitments', async () => {
    const {api, medium, small, flour, ingredient, buy, put, order, planning, shopping} = await planningSeed(), salt = await ingredient('Salt');
    await buy(salt.id, {quantity: '1', unit: 'kg', total_cost_minor: 200}); await put([{ingredient_id: flour.id, quantity: '750', unit: 'g'}, {ingredient_id: salt.id, quantity: '5', unit: 'g'}], 1);
    await order('2026-10-08', [[medium, 2]]); const mixed = await order('2026-10-10', [[medium, 2], [small, 1]]);
    const list = await shopping('2026-10-10'), plan = await planning('2026-10-10');
    expect(list).toMatchObject({timezone: 'America/Los_Angeles', period: {date_from: '2026-10-10', date_to: '2026-10-10'}, complete: false,
      missing: [{code: 'recipe_missing', variant_id: small.id, orders: [{order_id: mixed.id}]}],
      items: [{ingredient_id: flour.id, ingredient_name: 'Flour', base_unit: 'g', stock_on_hand: '2000', earlier_demand: '1500', period_demand: '1500', cumulative_shortage: '1000'}]});
    expect(list.items).toHaveLength(1); expect(plan.ingredients.map((row: any) => [row.ingredient_name, row.cumulative_shortage])).toEqual([['Flour', '1000'], ['Salt', '0']]);
    expect(Object.keys(list).sort()).toEqual(['calculated_at', 'complete', 'id', 'items', 'missing', 'period', 'timezone']);
    await expect(shopping('2026-10-08')).resolves.toMatchObject({complete: true, missing: [], items: []});
    const today = (await api.request<any>('/dashboard')).business_date;
    await expect(api.request('/planning/shopping-list')).resolves.toMatchObject({period: {date_from: today, date_to: today}});
    for (const query of ['date_from=2026-10-10', 'date_from=2026-01-01&date_to=2027-01-02', 'date_from=2026-10-10&date_to=2026-10-10&sort=name']) {
      await expect(api.request(`/planning/shopping-list?${query}`), query).rejects.toMatchObject({status: 422, code: 'validation_failed'});
    }
  });

  it.skipIf(conformance)('answers only the planning route and refuses it without the planning capability', async () => {
    const closed = async () => null;
    const handler = createPlanningFixtures({orders: closed, menu: closed, recipes: closed, inventory: closed, settings: sampleSettings});
    expect(await handler(new URL('http://fixture/api/v1/orders'))).toBeNull(); expect(await handler(new URL('http://fixture/api/v1/planning/other'))).toBeNull();
    expect((await handler(new URL('http://fixture/api/v1/planning')))!.status).toBe(403); expect((await handler(new URL('http://fixture/api/v1/planning/shopping-list')))!.status).toBe(403);
  });
});
