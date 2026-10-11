import {describe, expect, it} from 'vitest';
import {checkedCorrectionOperation, checkedCorrectionPreview, checkedCorrectionResult, checkedCorrections, checkedPreparation, checkedPreparationOperation, checkedPreparationPreview, checkedPreparationResult} from '../src/preparation/responses';
import {planningSeed} from './planning-helpers';

const copy = <T,>(value: T, change: (draft: any) => void): T => {const draft = structuredClone(value); change(draft); return draft;};
async function examples() {
  const {api, medium, order, draft, preview} = await planningSeed({preparation: true}), saved = await order('2026-10-10', [[medium, 2]]), body = draft(saved, 1, '0.8');
  const reviewed = await preview(body), result = await api.request<any>('/preparations', {method: 'POST', operationId: 'example-key', body: {preview_id: reviewed.id, draft: body}});
  return {api, body, reviewed, result};
}

describe('preparation response boundary', () => {
  it('accepts the development preview, saved preparation and save result for their draft', async () => {
    const {body, reviewed, result} = await examples();
    expect(checkedPreparationPreview(reviewed, body)).toBe(reviewed); expect(checkedPreparation(result.preparation)).toBe(result.preparation); expect(checkedPreparationResult(result, body, 'example-key')).toBe(result);
    // Without the draft, as after a reload, the result is still checked against itself and its operation.
    expect(checkedPreparationResult(result, null, 'example-key')).toBe(result);
    expect(checkedPreparationPreview(copy(reviewed, draft => {draft.estimated_ingredient_cost_minor = null; draft.estimate_complete = false;
      draft.cost_basis_snapshots[0] = {ingredient_id: draft.cost_basis_snapshots[0].ingredient_id, purchase_id: null, purchase_line_id: null, purchased_on: null, unit_cost: null};}), body)).toBeTruthy();
  });

  it('rejects a preview whose counts, stock effects, cost or draft do not agree', async () => {
    const {body, reviewed} = await examples();
    const invalid: ((draft: any) => void)[] = [draft => {draft.id = '';}, draft => {draft.expires_at = '2026-10-10';}, draft => {draft.prepared_on = '2026-10-11';}, draft => {draft.note = 'Another note';}, draft => {draft.currency = 'usd';},
      draft => {draft.allocations = [];}, draft => {draft.allocations[0].quantity = 2;}, draft => {draft.allocations[0].prepared_after = 2;}, draft => {draft.allocations[0].remaining_after = 0;}, draft => {draft.allocations[0].order_id = 'another-order';},
      draft => {draft.allocations[0].expected_version = 2;}, draft => {draft.allocations[0].ordered_quantity = 0; draft.allocations[0].remaining_after = -1;}, draft => {draft.allocations[0].variant_id = '';}, draft => {draft.allocations.push(draft.allocations[0]);},
      draft => {draft.consumption[0].base_quantity = '80';}, draft => {draft.consumption[0].after_quantity = '2000';}, draft => {draft.consumption[0].before_quantity = '500'; draft.consumption[0].after_quantity = '-300';},
      draft => {draft.consumption[0].unit = 'g';}, draft => {draft.consumption[0].ingredient_id = 'another-ingredient';}, draft => {draft.consumption = [];}, draft => {draft.estimated_ingredient_cost_minor = null;},
      draft => {draft.estimate_complete = false;}, draft => {draft.cost_basis_snapshots[0].unit_cost = null;}, draft => {draft.cost_basis_snapshots = [];}, draft => {draft.recipe_snapshots[0].recipe_version = null;}, draft => {draft.recipe_snapshots[0].variant_id = 'another-variant';}, draft => {delete draft.recipe_snapshots;}];
    for (const [index, change] of invalid.entries()) expect(() => checkedPreparationPreview(copy(reviewed, change), body), `case ${index}`).toThrow('The server returned an invalid preparation response.');
    expect(() => checkedPreparationPreview(null, body)).toThrow();
  });

  it('rejects a save result that does not carry its operation, its draft or the changed orders and stock', async () => {
    const {body, result} = await examples();
    const invalid: ((draft: any) => void)[] = [draft => {draft.preparation.operation_id = 'another-key';}, draft => {draft.preparation.allocations[0].quantity = 2;}, draft => {draft.preparation.consumption[0].stock_movement_id = '';},
      draft => {draft.preparation.consumption[0].base_quantity = '900';}, draft => {draft.preparation.recorded_at = 'now';}, draft => {draft.preparation.prepared_on = '2026-10-09';}, draft => {draft.orders = [];},
      draft => {draft.orders[0].version = 1;}, draft => {draft.orders[0].items[0].prepared_quantity = 0; draft.orders[0].items[0].remaining_quantity = 2;}, draft => {draft.orders.push(draft.orders[0]);},
      draft => {draft.ingredients = [];}, draft => {draft.ingredients[0].version = 2;}, draft => {draft.ingredients[0].stock_on_hand = '2000';}, draft => {delete draft.preparation;},
      draft => {draft.preparation.consumption[0].after_quantity = '1300';}, draft => {draft.orders[0].preparation_tracking = 'manual';}];
    for (const [index, change] of invalid.entries()) expect(() => checkedPreparationResult(copy(result, change), body, 'example-key'), `case ${index}`).toThrow('The server returned an invalid preparation response.');
    expect(() => checkedPreparation(copy(result.preparation, draft => {draft.allocations = [];}))).toThrow('The server returned an invalid preparation response.');
    expect(() => checkedPreparationResult(result, body, 'another-key')).toThrow('The server returned an invalid preparation response.');
  });

  it('reads a preparation operation only when it names its own result or a complete rejection', async () => {
    const {api, body, result} = await examples(), done = await api.request<any>('/operations/example-key');
    expect(checkedPreparationOperation(done, 'example-key')).toBe(done); expect(done.result.body).toEqual(result);
    await expect(api.request('/preparations', {method: 'POST', operationId: 'rejected-key', body: {preview_id: 'missing', draft: body}})).rejects.toMatchObject({status: 409});
    const rejected = await api.request<any>('/operations/rejected-key'); expect(checkedPreparationOperation(rejected, 'rejected-key')).toBe(rejected);
    const processing = {operation_id: 'example-key', state: 'processing', resource_type: null, resource_id: null, result: null, error: null, started_at: done.started_at, completed_at: null};
    expect(checkedPreparationOperation(processing, 'example-key')).toBe(processing);
    const invalid: [any, string][] = [[done, 'another-key'], [copy(done, draft => {draft.resource_type = 'order';}), 'example-key'], [copy(done, draft => {draft.resource_id = 'another-preparation';}), 'example-key'],
      [copy(done, draft => {draft.result.body.preparation.operation_id = 'another-key';}), 'example-key'], [copy(done, draft => {draft.result = null;}), 'example-key'], [copy(done, draft => {draft.completed_at = null;}), 'example-key'],
      [copy(rejected, draft => {draft.error.error.message = '';}), 'rejected-key'], [copy(rejected, draft => {draft.error.http_status = 200;}), 'rejected-key'], [{...processing, result: done.result}, 'example-key'], [{...processing, state: 'unknown'}, 'example-key']];
    for (const [index, [value, id]] of invalid.entries()) expect(() => checkedPreparationOperation(value, id), `case ${index}`).toThrow('The server returned an invalid preparation response.');
  });

  it('checks a correction preview, its saved result, its operation and the list of corrections against the draft and the record', async () => {
    const seed = await planningSeed({preparation: true}), saved = await seed.order('2026-10-10', [[seed.medium, 3]]), done = await seed.prepare(seed.draft(saved, 2, '1.5')), record = done.preparation;
    const body = seed.amend(record, done.orders[0], -1, '750'), reviewed = await seed.correctionPreview(record, body);
    const result = await seed.api.request<any>(`/preparations/${record.id}/corrections`, {method: 'POST', operationId: 'correction-key', body: {...body, preview_id: reviewed.id}});
    const listed = await seed.api.request<any>(`/preparations/${record.id}/corrections`), operation = await seed.api.request<any>('/operations/correction-key'), fails = 'The server returned an invalid preparation response.';
    expect(checkedCorrectionPreview(reviewed, body, record.id)).toBe(reviewed); expect(checkedCorrectionResult(result, body, 'correction-key', record.id)).toBe(result); expect(checkedCorrectionResult(result, null, 'correction-key', record.id)).toBe(result);
    expect(checkedCorrections(listed, record.id)).toBe(listed.items); expect(checkedCorrectionOperation(operation, 'correction-key', record.id)).toBe(operation);
    const previews: ((draft: any) => void)[] = [draft => {draft.id = '';}, draft => {draft.preparation_id = 'another';}, draft => {draft.reason = 'Another reason';}, draft => {draft.allocations[0].delta_quantity = -2;},
      draft => {draft.allocations[0].prepared_after = 2;}, draft => {draft.allocations[0].remaining_after = 1;}, draft => {draft.allocations[0].expected_version = 1;}, draft => {draft.allocations[0].ordered_quantity = 0; draft.allocations[0].remaining_after = -1;},
      draft => {draft.allocations[0].prepared_before = 0; draft.allocations[0].prepared_after = -1; draft.allocations[0].remaining_after = 4;}, draft => {draft.allocations = [];},
      draft => {draft.stock_corrections[0].after_quantity = '500';}, draft => {draft.stock_corrections[0].delta_base_quantity = '700'; draft.stock_corrections[0].after_quantity = '1200';},
      draft => {draft.stock_corrections[0].corrects_movement_id = 'another';}, draft => {draft.stock_corrections[0].before_quantity = '100'; draft.stock_corrections[0].delta_base_quantity = '-750'; draft.stock_corrections[0].after_quantity = '-650';}, draft => {draft.expires_at = 'soon';}];
    for (const [index, change] of previews.entries()) expect(() => checkedCorrectionPreview(copy(reviewed, change), body, record.id), `preview ${index}`).toThrow(fails);
    const results: ((draft: any) => void)[] = [draft => {draft.correction.operation_id = 'another';}, draft => {draft.correction.preparation_id = 'another';}, draft => {draft.correction.stock_corrections[0].stock_movement_id = '';},
      draft => {draft.correction.recorded_at = 'now';}, draft => {draft.orders = [];}, draft => {draft.orders[0].version = 2;}, draft => {draft.orders[0].items[0].prepared_quantity = 2; draft.orders[0].items[0].remaining_quantity = 1;},
      draft => {draft.ingredients = [];}, draft => {draft.ingredients[0].stock_on_hand = '500';}, draft => {draft.ingredients[0].version = 3;}, draft => {delete draft.correction;}];
    for (const [index, change] of results.entries()) expect(() => checkedCorrectionResult(copy(result, change), body, 'correction-key', record.id), `result ${index}`).toThrow(fails);
    expect(() => checkedCorrections({items: [{...result.correction, preparation_id: 'another'}]}, record.id)).toThrow(fails); expect(() => checkedCorrections({items: [result.correction, result.correction]}, record.id)).toThrow(fails); expect(() => checkedCorrections({}, record.id)).toThrow(fails);
    expect(() => checkedCorrectionOperation(copy(operation, draft => {draft.resource_type = 'preparation';}), 'correction-key', record.id)).toThrow(fails); expect(() => checkedCorrectionOperation(operation, 'another-key', record.id)).toThrow(fails);
    expect(() => checkedCorrectionOperation(copy(operation, draft => {draft.resource_id = 'another';}), 'correction-key', record.id)).toThrow(fails);
  });
});
