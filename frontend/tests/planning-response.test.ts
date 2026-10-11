import {describe, expect, it} from 'vitest';
import {checkedPlanning, checkedShoppingList} from '../src/planning/responses';
import {planningSeed} from './planning-helpers';

const copy = <T,>(value: T, change: (draft: any) => void): T => {const draft = structuredClone(value); change(draft); return draft;};
async function examples() {
  const {medium, small, order, planning, shopping} = await planningSeed();
  await order('2026-10-08', [[medium, 3]]); await order('2026-10-10', [[medium, 1], [small, 2]]);
  return {plan: await planning('2026-10-10'), empty: await planning('2026-10-01'), list: await shopping('2026-10-10'), nothing: await shopping('2026-10-01')};
}

describe('planning response boundary', () => {
  it('accepts an incomplete plan with an earlier deficit and an empty complete plan', async () => {
    const {plan, empty} = await examples();
    expect(checkedPlanning(plan)).toBe(plan); expect(checkedPlanning(empty)).toBe(empty);
    expect(plan).toMatchObject({complete: false, ingredients: [{stock_after_earlier: '-250', earlier_shortage: '250', period_shortage: '750', cumulative_shortage: '1000'}]});
    expect(empty).toMatchObject({complete: true, foods: [], ingredients: [], missing: []});
  });

  it('rejects a plan with an invalid identity, period, completeness or permitted action', async () => {
    const {plan, empty} = await examples();
    const invalid: [any, (draft: any) => void][] = [[plan, draft => {draft.id = '';}], [plan, draft => {draft.calculated_at = '2026-10-10';}], [plan, draft => {draft.timezone = 'Mars/Phobos';}],
      [plan, draft => {draft.period.date_from = '2026-10-11';}], [plan, draft => {draft.period.date_to = '2026-02-30';}], [plan, draft => {draft.complete = true;}], [plan, draft => {draft.missing = [];}],
      [empty, draft => {draft.complete = false;}], [plan, draft => {draft.permitted_actions.record_preparation.reason = '';}], [plan, draft => {delete draft.permitted_actions;}],
      [plan, draft => {draft.missing[0].code = 'price_missing';}], [plan, draft => {draft.missing[0].orders = [];}], [plan, draft => {draft.missing[0].food_id = '';}], [plan, draft => {draft.missing.push(draft.missing[0]);}]];
    for (const [index, [value, change]] of invalid.entries()) expect(() => checkedPlanning(copy(value, change)), `case ${index}`).toThrow('The server returned an invalid planning response.');
    expect(() => checkedPlanning(null)).toThrow();
  });

  it('rejects demand rows whose quantities, statuses or contributing orders do not add up', async () => {
    const {plan} = await examples();
    const invalid: ((draft: any) => void)[] = [draft => {draft.foods[0].remaining_quantity = 2;}, draft => {draft.foods[0].ordered_quantity = 5;}, draft => {draft.foods[0].orders = [];},
      draft => {draft.foods[0].orders[0].status = 'pending';}, draft => {draft.foods[0].orders[0].status = 'completed';}, draft => {draft.foods[0].orders[0].remaining_quantity = 0;},
      draft => {draft.foods[0].orders[0].prepared_quantity = 2; draft.foods[0].orders[0].remaining_quantity = -1; draft.foods[0].prepared_quantity = 2; draft.foods[0].remaining_quantity = -1;},
      draft => {draft.foods[0].orders[0].ordered_quantity = 1.5;}, draft => {draft.foods[0].orders[0].order_version = 0;}, draft => {delete draft.foods[0].orders[0].order_version;}, draft => {draft.foods.push(draft.foods[0]);}, draft => {draft.foods[0].orders.push(draft.foods[0].orders[0]); draft.foods[0].ordered_quantity = 2; draft.foods[0].remaining_quantity = 2;},
      draft => {draft.foods[0].selling_unit = 'box';}, draft => {draft.foods[0].package_contents = {quantity: 10, unit: 'piece'};}, draft => {draft.foods[0].food_name = '';}];
    for (const [index, change] of invalid.entries()) expect(() => checkedPlanning(copy(plan, change)), `case ${index}`).toThrow('The server returned an invalid planning response.');
  });

  it('rejects ingredient rows that double-count commitments or hide a shortage', async () => {
    const {plan} = await examples();
    const invalid: ((draft: any) => void)[] = [draft => {draft.ingredients[0].stock_after_earlier = '0';}, draft => {draft.ingredients[0].stock_after_earlier = '250';},
      draft => {draft.ingredients[0].earlier_shortage = '0';}, draft => {draft.ingredients[0].period_shortage = '0';}, draft => {draft.ingredients[0].period_shortage = '1000';},
      draft => {draft.ingredients[0].cumulative_shortage = '750';}, draft => {draft.ingredients[0].period_demand = '-750';}, draft => {draft.ingredients[0].earlier_demand = '2.25e3';},
      draft => {draft.ingredients[0].stock_on_hand = 2000;}, draft => {draft.ingredients[0].base_unit = 'kg';}, draft => {draft.ingredients[0].ingredient_name = '';},
      draft => {draft.ingredients.push(draft.ingredients[0]);}, draft => {draft.ingredients[0] = {...draft.ingredients[0], base_unit: 'piece', period_demand: '750.5'};}];
    for (const [index, change] of invalid.entries()) expect(() => checkedPlanning(copy(plan, change)), `case ${index}`).toThrow('The server returned an invalid planning response.');
  });

  it('accepts a shopping list and rejects one that miscounts, pads or mislabels what to buy', async () => {
    const {list, nothing} = await examples();
    expect(checkedShoppingList(list)).toBe(list); expect(checkedShoppingList(nothing)).toBe(nothing);
    expect(list).toMatchObject({complete: false, items: [{ingredient_name: 'Flour', stock_on_hand: '2000', earlier_demand: '2250', period_demand: '750', cumulative_shortage: '1000'}]});
    const invalid: [any, (draft: any) => void][] = [[list, draft => {draft.items[0].cumulative_shortage = '750';}], [list, draft => {draft.items[0].earlier_demand = '0';}],
      [list, draft => {draft.items[0].stock_on_hand = '3000'; draft.items[0].cumulative_shortage = '0';}], [list, draft => {draft.items.push(draft.items[0]);}], [list, draft => {draft.items[0].base_unit = 'kg';}],
      [list, draft => {draft.items[0].ingredient_name = '';}], [list, draft => {draft.items[0].period_demand = '-750';}], [list, draft => {delete draft.items;}], [list, draft => {draft.complete = true;}],
      [list, draft => {draft.missing = [];}], [list, draft => {draft.period.date_from = '2026-10-11';}], [list, draft => {draft.calculated_at = 'now';}], [nothing, draft => {draft.id = '';}]];
    for (const [index, [value, change]] of invalid.entries()) expect(() => checkedShoppingList(copy(value, change)), `case ${index}`).toThrow('The server returned an invalid shopping list response.');
    expect(() => checkedShoppingList(null)).toThrow();
  });
});
