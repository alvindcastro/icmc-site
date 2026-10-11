import {describe, expect, it} from 'vitest';
import {createPreparationFixtures} from '../src/api/preparation-fixtures';
import {sampleSettings} from './helpers';
import {planningSeed} from './planning-helpers';

const recording = () => planningSeed({preparation: true});

describe('preparation recording development contract', () => {
  it('tracks prepared and remaining quantities on orders and gates readiness on them only when recording is enabled', async () => {
    const {api, medium, order, advance} = await recording(), saved = await order('2026-10-10', [[medium, 2]]);
    await expect(api.request('/settings')).resolves.toMatchObject({capabilities: {preparation_recording: true}});
    expect(saved).toMatchObject({preparation_tracking: 'recorded', cancellation_requires_stock_acknowledgment: false, items: [{quantity: 2, prepared_quantity: 0, remaining_quantity: 2}],
      permitted_actions: {record_preparation: {allowed: true}, mark_ready: {allowed: false}}});
    const preparing = await advance(saved, 'preparing');
    expect(preparing.permitted_actions.mark_ready).toMatchObject({allowed: false, reason: 'Record all remaining preparation before marking ready.'});
    await expect(advance(preparing, 'ready')).rejects.toMatchObject({status: 409, code: 'action_not_allowed'});
    const manual = await planningSeed(), plain = await manual.order('2026-10-10', [[manual.medium, 2]]);
    expect(plain).toMatchObject({preparation_tracking: 'manual', items: [{prepared_quantity: null, remaining_quantity: null}], permitted_actions: {record_preparation: {allowed: false, reason: 'Preparation recording is not enabled.'}}});
    await expect(manual.preview(manual.draft(plain, 1, '0.8'))).rejects.toMatchObject({status: 403});
  });

  it('previews prepared counts, normalized usage, stock effects and the estimated cost without changing anything', async () => {
    const {api, medium, flour, purchase, order, draft, preview} = await recording(), saved = await order('2026-10-10', [[medium, 2]]);
    const result = await preview(draft(saved, 1, '0.8'));
    expect(result).toMatchObject({prepared_on: '2026-10-10', note: '', currency: 'USD', minor_digits: 2, estimated_ingredient_cost_minor: 960, estimate_complete: true,
      allocations: [{order_id: saved.id, reference: saved.reference, order_item_id: saved.items[0].id, variant_id: medium.id, expected_version: 1, food_name: 'Beef Caldereta', variant_label: 'Medium', selling_unit: 'tray', package_contents: null,
        ordered_quantity: 2, prepared_before: 0, quantity: 1, prepared_after: 1, remaining_after: 1}],
      consumption: [{ingredient_id: flour.id, ingredient_name: 'Flour', base_unit: 'g', expected_version: 2, quantity: '0.8', unit: 'kg', base_quantity: '800', before_quantity: '2000', after_quantity: '1200'}],
      recipe_snapshots: [{variant_id: medium.id, recipe_version: 1}], cost_basis_snapshots: [{ingredient_id: flour.id, purchase_id: purchase.id, purchased_on: '2026-10-07', unit_cost: '0.012000000'}]});
    expect(Date.parse(result.expires_at)).toBeGreaterThan(Date.now()); expect(typeof result.id).toBe('string');
    await expect(api.request(`/orders/${saved.id}`)).resolves.toMatchObject({version: 1, items: [{prepared_quantity: 0}]}); await expect(api.request(`/ingredients/${flour.id}`)).resolves.toMatchObject({stock_on_hand: '2000', version: 2});
  });

  it('records a preparation once: stock is deducted, prepared quantities rise and the status stays put', async () => {
    const {api, medium, flour, order, advance, draft, prepare, planning} = await recording(), saved = await order('2026-10-10', [[medium, 2]]), body = draft(saved, 1, '0.8');
    const preview = await api.request<any>('/preparations/preview', {method: 'POST', body: {draft: body}}), request = {method: 'POST', operationId: 'preparation-key', body: {preview_id: preview.id, draft: body}};
    const result = await api.request<any>('/preparations', request);
    expect(result).toMatchObject({preparation: {prepared_on: '2026-10-10', note: '', operation_id: 'preparation-key', recorded_by: 'Admin', estimated_ingredient_cost_minor: 960, estimate_complete: true, currency: 'USD', minor_digits: 2,
        allocations: [{order_id: saved.id, reference: saved.reference, order_item_id: saved.items[0].id, variant_id: medium.id, food_name: 'Beef Caldereta', variant_label: 'Medium', selling_unit: 'tray', package_contents: null, quantity: 1}],
        consumption: [{ingredient_id: flour.id, ingredient_name: 'Flour', base_unit: 'g', quantity: '0.8', unit: 'kg', base_quantity: '800', before_quantity: '2000', after_quantity: '1200'}], recipe_snapshots: [{variant_id: medium.id, recipe_version: 1}], cost_basis_snapshots: [{unit_cost: '0.012000000'}]},
      orders: [{id: saved.id, version: 2, status: 'confirmed', cancellation_requires_stock_acknowledgment: true, items: [{quantity: 2, prepared_quantity: 1, remaining_quantity: 1}]}],
      ingredients: [{id: flour.id, stock_on_hand: '1200', version: 3}]});
    await expect(api.request(`/preparations/${result.preparation.id}`)).resolves.toEqual(result.preparation);
    const movements = await api.request<any>(`/ingredients/${flour.id}/movements`);
    expect(movements.items[0]).toMatchObject({id: result.preparation.consumption[0].stock_movement_id, type: 'consumption', delta_base_quantity: '-800', before_quantity: '2000', after_quantity: '1200', preparation_id: result.preparation.id, operation_id: 'preparation-key'});
    await expect(api.request('/preparations', request)).resolves.toEqual(result); await expect(api.request(`/ingredients/${flour.id}`)).resolves.toMatchObject({stock_on_hand: '1200', version: 3});
    await expect(api.request('/operations/preparation-key')).resolves.toMatchObject({state: 'succeeded', resource_type: 'preparation', resource_id: result.preparation.id, result: {http_status: 201, body: result}});
    await expect(planning('2026-10-10')).resolves.toMatchObject({foods: [{ordered_quantity: 2, prepared_quantity: 1, remaining_quantity: 1}], ingredients: [{stock_on_hand: '1200', period_demand: '750'}]});
    const rest = await prepare(draft(result.orders[0], 1, '0.7', {consumption: [{ingredient_id: flour.id, expected_version: 3, quantity: '0.7', unit: 'kg'}]}));
    expect(rest.orders[0]).toMatchObject({version: 3, items: [{prepared_quantity: 2, remaining_quantity: 0}], permitted_actions: {record_preparation: {allowed: false, reason: 'Nothing remains to prepare.'}}});
    await expect(advance(rest.orders[0], 'preparing', 'ready', 'completed')).resolves.toMatchObject({status: 'completed'});
  });

  it('rejects allocations beyond what remains, repeated lines, ineligible orders and stale versions without any effect', async () => {
    const {api, medium, flour, order, draft, preview} = await recording(), saved = await order('2026-10-10', [[medium, 2]]), pending = await order('2026-10-10', [[medium, 1]], 'pending'), body = draft(saved, 1, '0.8');
    const invalid: [unknown, string][] = [[draft(saved, 3, '0.8'), '/draft/allocations/0/quantity'], [draft(saved, 0, '0.8'), '/draft/allocations/0/quantity'], [{...body, allocations: []}, '/draft/allocations'],
      [{...body, allocations: [body.allocations[0], body.allocations[0]]}, '/draft/allocations/1/order_item_id'], [draft(pending, 1, '0.8'), '/draft/allocations/0/order_id'],
      [{...body, allocations: [{...body.allocations[0], order_item_id: 'another-item'}]}, '/draft/allocations/0/order_item_id'], [{...body, prepared_on: '2026-02-30'}, '/draft/prepared_on'], [{...body, extra: true}, '/draft/extra']];
    for (const [value, path] of invalid) await expect(preview(value), path).rejects.toMatchObject({status: 422, code: 'validation_failed', fieldErrors: [{path}]});
    await expect(preview({...body, allocations: [{...body.allocations[0], expected_version: 5}]})).rejects.toMatchObject({status: 409, code: 'version_conflict', details: {resource_type: 'order', resource_id: saved.id, current_version: 1, latest_resource: {id: saved.id}}});
    await expect(preview({...body, consumption: [{...body.consumption[0], expected_version: 1}]})).rejects.toMatchObject({status: 409, code: 'version_conflict', details: {resource_type: 'ingredient', resource_id: flour.id, current_version: 2}});
    await expect(api.request(`/orders/${saved.id}`)).resolves.toMatchObject({version: 1, items: [{prepared_quantity: 0}]});
  });

  it('requires explicit actual usage or an explanation, in compatible units and within physical stock', async () => {
    const {api, medium, flour, ingredient, order, draft, preview} = await recording(), saved = await order('2026-10-10', [[medium, 2]]), row = {ingredient_id: flour.id, expected_version: 2, quantity: '0.8', unit: 'kg'};
    const invalid: [unknown, string][] = [[draft(saved, 1, null), '/draft/note'], [draft(saved, 1, '0'), '/draft/consumption/0/quantity'], [draft(saved, 1, '0.8', {consumption: [{...row, unit: 'ml'}]}), '/draft/consumption/0/unit'],
      [draft(saved, 1, '0.8', {consumption: [row, row]}), '/draft/consumption/1/ingredient_id'], [draft(saved, 1, '0.8', {consumption: [{...row, ingredient_id: 'unknown'}]}), '/draft/consumption/0/ingredient_id'],
      [draft(saved, 1, '0.8', {note: 'x'.repeat(2001)}), '/draft/note']];
    for (const [value, path] of invalid) await expect(preview(value), path).rejects.toMatchObject({status: 422, fieldErrors: [{path}]});
    await expect(preview(draft(saved, 1, '3'))).rejects.toMatchObject({status: 409, code: 'insufficient_stock', fieldErrors: [{path: '/draft/consumption/0/quantity'}]});
    await expect(preview(draft(saved, 1, null, {note: 'Assembled from prepared stock.'}))).resolves.toMatchObject({consumption: [], estimated_ingredient_cost_minor: 0, estimate_complete: true, note: 'Assembled from prepared stock.'});
    const salt = await ingredient('Salt'); await api.request(`/ingredients/${salt.id}/movements`, {method: 'POST', operationId: crypto.randomUUID(), body: {expected_version: 1, type: 'opening', delta_base_quantity: '500', reason: 'Opening count', preparation_id: null, corrects_movement_id: null,
      preview_id: (await api.request<any>(`/ingredients/${salt.id}/movement-preview`, {method: 'POST', body: {expected_version: 1, type: 'opening', delta_base_quantity: '500', reason: 'Opening count', preparation_id: null, corrects_movement_id: null}})).id}});
    await expect(preview(draft(saved, 1, '0.8', {consumption: [row, {ingredient_id: salt.id, expected_version: 2, quantity: '5', unit: 'g'}]}))).resolves.toMatchObject({estimated_ingredient_cost_minor: null, estimate_complete: false,
      cost_basis_snapshots: [{ingredient_id: flour.id, unit_cost: '0.012000000'}, {ingredient_id: salt.id, purchase_id: null, purchased_on: null, unit_cost: null}]});
  });

  it('binds a save to its reviewed preview and to an operation key', async () => {
    const {api, medium, flour, order, draft, preview} = await recording(), saved = await order('2026-10-10', [[medium, 2]]), body = draft(saved, 1, '0.8'), reviewed = await preview(body);
    await expect(api.request('/preparations', {method: 'POST', body: {preview_id: reviewed.id, draft: body}})).rejects.toMatchObject({status: 422});
    await expect(api.request('/preparations', {method: 'POST', operationId: 'changed', body: {preview_id: reviewed.id, draft: draft(saved, 2, '0.8')}})).rejects.toMatchObject({status: 409, code: 'quote_stale'});
    await expect(api.request('/preparations', {method: 'POST', operationId: 'unknown', body: {preview_id: 'missing', draft: body}})).rejects.toMatchObject({status: 409, code: 'quote_stale'});
    await expect(api.request('/operations/changed')).resolves.toMatchObject({state: 'rejected', error: {http_status: 409}});
    await expect(api.request(`/ingredients/${flour.id}`)).resolves.toMatchObject({stock_on_hand: '2000'}); await expect(api.request('/preparations/unknown')).rejects.toMatchObject({status: 404});
  });

  it('keeps prepared lines, their minimum quantity and consumed stock when a partly prepared order is edited or cancelled', async () => {
    const {api, medium, small, flour, order, draft, prepare, cancel} = await recording(), saved = await order('2026-10-10', [[medium, 3]]), prepared = (await prepare(draft(saved, 2, '1.5'))).orders[0];
    const edit = (items: unknown[]) => api.request<any>('/orders/quote', {method: 'POST', body: {order_id: prepared.id, expected_version: prepared.version, draft: {customer: prepared.customer,
      fulfillment: {method: 'pickup', local_date: '2026-10-10', local_time: '12:00', timezone: 'America/Los_Angeles', utc_offset: null, address: null}, items, notes: '', delivery_charge_minor: 0, tax_minor: 0}}});
    const line = {client_line_id: 'kept', order_item_id: prepared.items[0].id, variant_id: medium.id, quantity: 3, preparation_notes: ''};
    await expect(edit([{...line, quantity: 1}])).rejects.toMatchObject({status: 422, fieldErrors: [{path: '/draft/items/0/quantity'}]});
    await expect(edit([{client_line_id: 'new', variant_id: small.id, quantity: 1, preparation_notes: ''}])).rejects.toMatchObject({status: 422, fieldErrors: [{path: '/draft/items'}]});
    await expect(edit([{...line, quantity: 4}])).resolves.toMatchObject({lines: [{quantity: 4, prepared_quantity: 2, remaining_quantity: 2}]});
    await expect(cancel(prepared)).rejects.toMatchObject({status: 422, fieldErrors: [{path: '/acknowledge_consumed_stock'}]});
    await expect(api.request(`/orders/${prepared.id}/cancel`, {method: 'POST', operationId: crypto.randomUUID(), body: {expected_version: prepared.version, reason: 'Customer cancelled', acknowledge_consumed_stock: true}})).resolves.toMatchObject({status: 'cancelled', items: [{prepared_quantity: 2}]});
    await expect(api.request(`/ingredients/${flour.id}`)).resolves.toMatchObject({stock_on_hand: '500'});
  });

  it('links waste and correction movements to the preparation that used the ingredient', async () => {
    const {api, medium, flour, ingredient, order, draft, prepare} = await recording(), saved = await order('2026-10-10', [[medium, 2]]), done = await prepare(draft(saved, 1, '0.8')), used = done.preparation.consumption[0].stock_movement_id;
    const move = async (changes: Record<string, unknown>, version: number, target: string = flour.id) => {
      const body = {expected_version: version, type: 'correction', delta_base_quantity: '200', reason: 'Unused flour returned', preparation_id: done.preparation.id, corrects_movement_id: used, ...changes};
      const preview = await api.request<any>(`/ingredients/${target}/movement-preview`, {method: 'POST', body});
      return api.request<any>(`/ingredients/${target}/movements`, {method: 'POST', operationId: crypto.randomUUID(), body: {...body, preview_id: preview.id}});
    };
    const unlinked = {status: 422, fieldErrors: expect.arrayContaining([expect.objectContaining({path: '/preparation_id'})])};
    await expect(move({preparation_id: 'unknown'}, 3)).rejects.toMatchObject(unlinked);
    // A preparation can only be linked from an ingredient it actually used.
    const salt = await ingredient('Salt'); await expect(move({corrects_movement_id: null}, 1, salt.id)).rejects.toMatchObject(unlinked);
    await expect(move({}, 3)).resolves.toMatchObject({ingredient: {stock_on_hand: '1400', version: 4}, movement: {type: 'correction', delta_base_quantity: '200', preparation_id: done.preparation.id, corrects_movement_id: used}});
    await expect(move({type: 'waste', delta_base_quantity: '-100', reason: 'Spilled', corrects_movement_id: null}, 4)).resolves.toMatchObject({ingredient: {stock_on_hand: '1300'}, movement: {type: 'waste', preparation_id: done.preparation.id, corrects_movement_id: null}});
    // The preparation record itself never changes.
    await expect(api.request(`/preparations/${done.preparation.id}`)).resolves.toEqual(done.preparation);
    const manual = await planningSeed();
    await expect(manual.api.request(`/ingredients/${manual.flour.id}/movement-preview`, {method: 'POST', body: {expected_version: 2, type: 'waste', delta_base_quantity: '-1', reason: 'Spilled', preparation_id: 'any', corrects_movement_id: null}})).rejects.toMatchObject(unlinked);
  });

  // Three trays ordered and two prepared with 1.5 kg of Flour: the order is at version 2 and Flour at version 3 with 500 g left.
  async function prepared() {const seed = await recording(), saved = await seed.order('2026-10-10', [[seed.medium, 3]]), done = await seed.prepare(seed.draft(saved, 2, '1.5')); return {...seed, saved, current: done.orders[0], record: done.preparation};}

  it('previews and records a prepared-count correction with its stock adjustment exactly once', async () => {
    const {api, flour, current, record, amend, correctionPreview, planning} = await prepared(), body = amend(record, current, -1, '750'), used = record.consumption[0].stock_movement_id;
    const reviewed = await correctionPreview(record, body);
    expect(reviewed).toMatchObject({preparation_id: record.id, reason: 'Only one tray was cooked',
      allocations: [{order_id: current.id, reference: current.reference, order_item_id: current.items[0].id, expected_version: 2, food_name: 'Beef Caldereta', variant_label: 'Medium', selling_unit: 'tray', package_contents: null,
        ordered_quantity: 3, prepared_before: 2, delta_quantity: -1, prepared_after: 1, remaining_after: 2}],
      stock_corrections: [{ingredient_id: flour.id, ingredient_name: 'Flour', base_unit: 'g', expected_version: 3, corrects_movement_id: used, delta_base_quantity: '750', before_quantity: '500', after_quantity: '1250'}]});
    expect(Date.parse(reviewed.expires_at)).toBeGreaterThan(Date.now());
    await expect(api.request(`/orders/${current.id}`)).resolves.toMatchObject({version: 2, items: [{prepared_quantity: 2}]}); await expect(api.request(`/ingredients/${flour.id}`)).resolves.toMatchObject({stock_on_hand: '500'});
    const request = {method: 'POST', operationId: 'correction-key', body: {...body, preview_id: reviewed.id}}, result = await api.request<any>(`/preparations/${record.id}/corrections`, request);
    expect(result).toMatchObject({correction: {preparation_id: record.id, reason: 'Only one tray was cooked', operation_id: 'correction-key', recorded_by: 'Admin',
        allocations: [{order_item_id: current.items[0].id, ordered_quantity: 3, prepared_before: 2, delta_quantity: -1, prepared_after: 1, remaining_after: 2}],
        stock_corrections: [{ingredient_id: flour.id, corrects_movement_id: used, delta_base_quantity: '750', before_quantity: '500', after_quantity: '1250'}]},
      orders: [{id: current.id, version: 3, status: 'confirmed', items: [{quantity: 3, prepared_quantity: 1, remaining_quantity: 2}]}], ingredients: [{id: flour.id, stock_on_hand: '1250', version: 4}]});
    expect((await api.request<any>(`/ingredients/${flour.id}/movements`)).items[0]).toMatchObject({id: result.correction.stock_corrections[0].stock_movement_id, type: 'correction', delta_base_quantity: '750',
      reason: 'Only one tray was cooked', preparation_id: record.id, corrects_movement_id: used, operation_id: 'correction-key'});
    await expect(api.request(`/preparations/${record.id}/corrections`, request)).resolves.toEqual(result); await expect(api.request(`/ingredients/${flour.id}`)).resolves.toMatchObject({stock_on_hand: '1250', version: 4});
    await expect(api.request('/operations/correction-key')).resolves.toMatchObject({state: 'succeeded', resource_type: 'preparation_correction', resource_id: result.correction.id, result: {http_status: 201, body: result}});
    // The original record is immutable; its corrections are listed beside it.
    await expect(api.request(`/preparations/${record.id}`)).resolves.toEqual(record); await expect(api.request(`/preparations/${record.id}/corrections`)).resolves.toEqual({items: [result.correction]});
    await expect(planning('2026-10-10')).resolves.toMatchObject({foods: [{ordered_quantity: 3, prepared_quantity: 1, remaining_quantity: 2}]});
  });

  it('keeps a correction within what the preparation recorded, what was ordered and physical stock', async () => {
    const {api, flour, ingredient, current, record, amend, correctionPreview} = await prepared(), body = amend(record, current, -1, '750'), row = body.stock_corrections[0];
    const invalid: [unknown, string][] = [[amend(record, current, -3, null), '/allocations/0/delta_quantity'], [amend(record, current, 2, null), '/allocations/0/delta_quantity'],
      [{...body, allocations: [{...body.allocations[0], delta_quantity: 0}]}, '/allocations/0/delta_quantity'], [amend(record, current, 0, null), '/allocations'], [{...body, reason: ' '}, '/reason'],
      [{...body, allocations: [{...body.allocations[0], order_item_id: 'another-item'}]}, '/allocations/0/order_item_id'], [{...body, stock_corrections: [{...row, corrects_movement_id: 'another-movement'}]}, '/stock_corrections/0/corrects_movement_id'],
      [{...body, stock_corrections: [{...row, delta_base_quantity: '0'}]}, '/stock_corrections/0/delta_base_quantity'], [{...body, stock_corrections: [row, row]}, '/stock_corrections/1/ingredient_id'], [{...body, extra: true}, '/extra']];
    for (const [value, path] of invalid) await expect(correctionPreview(record, value), path).rejects.toMatchObject({status: 422, code: 'validation_failed', fieldErrors: [{path}]});
    const salt = await ingredient('Salt');
    await expect(correctionPreview(record, {...body, stock_corrections: [{...row, ingredient_id: salt.id, expected_version: 1}]})).rejects.toMatchObject({status: 422, fieldErrors: [{path: '/stock_corrections/0/ingredient_id'}]});
    await expect(correctionPreview(record, amend(record, current, -1, '-600'))).rejects.toMatchObject({status: 409, code: 'insufficient_stock', fieldErrors: [{path: '/stock_corrections/0/delta_base_quantity'}]});
    await expect(correctionPreview(record, {...body, allocations: [{...body.allocations[0], expected_version: 1}]})).rejects.toMatchObject({status: 409, code: 'version_conflict', details: {resource_type: 'order', resource_id: current.id, current_version: 2}});
    await expect(correctionPreview(record, {...body, stock_corrections: [{...row, expected_version: 2}]})).rejects.toMatchObject({status: 409, code: 'version_conflict', details: {resource_type: 'ingredient', resource_id: flour.id, current_version: 3}});
    await expect(correctionPreview({id: 'unknown'}, body)).rejects.toMatchObject({status: 404});
    const reviewed = await correctionPreview(record, body);
    await expect(api.request(`/preparations/${record.id}/corrections`, {method: 'POST', body: {...body, preview_id: reviewed.id}})).rejects.toMatchObject({status: 422});
    await expect(api.request(`/preparations/${record.id}/corrections`, {method: 'POST', operationId: 'changed', body: {...amend(record, current, 1, null), preview_id: reviewed.id}})).rejects.toMatchObject({status: 409, code: 'quote_stale'});
    await expect(api.request(`/orders/${current.id}`)).resolves.toMatchObject({version: 2, items: [{prepared_quantity: 2}]}); await expect(api.request(`/preparations/${record.id}/corrections`)).resolves.toEqual({items: []});
  });

  it('refuses to lower prepared counts on a Ready order and never returns a cancelled order to demand', async () => {
    const {api, medium, order, advance, draft, prepare, amend, correctionPreview, correct, planning} = await recording(), full = await order('2026-10-10', [[medium, 2]]), done = await prepare(draft(full, 2, '1.5'));
    const ready = await advance(done.orders[0], 'preparing', 'ready');
    await expect(correctionPreview(done.preparation, amend(done.preparation, ready, -1, null))).rejects.toMatchObject({status: 422, fieldErrors: [{path: '/allocations/0/delta_quantity', message: 'Prepared quantities cannot be lowered while the order is Ready or Completed.'}]});
    const other = await order('2026-10-10', [[medium, 2]]), partly = await prepare(draft(other, 1, '0.5', {consumption: [{ingredient_id: done.ingredients[0].id, expected_version: 3, quantity: '0.5', unit: 'kg'}]}));
    const cancelled = await api.request<any>(`/orders/${other.id}/cancel`, {method: 'POST', operationId: crypto.randomUUID(), body: {expected_version: partly.orders[0].version, reason: 'Customer cancelled', acknowledge_consumed_stock: true}});
    const amended = await correct(partly.preparation, amend(partly.preparation, cancelled, -1, null));
    expect(amended.orders[0]).toMatchObject({status: 'cancelled', items: [{prepared_quantity: 0, remaining_quantity: 2}], cancellation_requires_stock_acknowledgment: false});
    expect((await planning('2026-10-10')).foods[0].orders.map((row: any) => row.order_id)).toEqual([full.id]);
  });

  it('answers only preparation routes and refuses them without preparation recording', async () => {
    const closed = Object.assign(async () => null, {allocate: () => [], consume: () => ({movements: [], ingredients: []}), correct: () => ({movements: [], ingredients: []})});
    const handler = createPreparationFixtures({orders: closed, inventory: closed, recipes: closed, settings: sampleSettings, operations: new Map()});
    expect(await handler(new URL('http://fixture/api/v1/planning'))).toBeNull(); expect(await handler(new URL('http://fixture/api/v1/orders'))).toBeNull();
    expect((await handler(new URL('http://fixture/api/v1/preparations/preview'), {method: 'POST', body: '{}'}))!.status).toBe(403); expect((await handler(new URL('http://fixture/api/v1/preparations/one')))!.status).toBe(403);
  });
});
