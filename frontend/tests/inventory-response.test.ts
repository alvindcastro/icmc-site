import {describe, expect, it} from 'vitest';
import {createFixtureTransport} from '../src/api/fixtures';
import {createApiClient} from '../src/api/client';
import {comparableCost, validQuantity} from '../src/inventory/model';
import {checkedIngredient, checkedInventoryOperation, checkedMovement, checkedMovementPreview, checkedPrice, checkedPurchase, checkedPurchasePreview} from '../src/inventory/responses';

async function data() {
  const api = createApiClient({baseUrl: '/api/v1', transport: createFixtureTransport({latency: 0}).fetch});
  const session = await api.request<any>('/auth/sign-in', {method: 'POST', body: {username: 'admin', token: 'local-admin-token'}}); api.setCsrfToken(session.csrf_token);
  const ingredient = await api.request<any>('/ingredients', {method: 'POST', operationId: 'ingredient', body: {name: 'Flour', base_unit: 'g', low_stock_threshold: '100'}});
  const draft = {supplier: 'Market', purchased_on: '2026-10-07', note: '', items: [{client_line_id: 'line', ingredient_id: ingredient.id, quantity: '2', unit: 'kg' as const, total_cost_minor: 2400, pack_contents: null}]};
  const preview = await api.request<any>('/purchases/preview', {method: 'POST', body: {draft}});
  const result = await api.request<any>('/purchases', {method: 'POST', operationId: 'purchase', body: {draft, preview_id: preview.id}});
  return {api, ingredient, draft, preview, result};
}
describe('inventory representations and response boundary', () => {
  it('preserves exact compatible quantities and rejects unsafe or ambiguous formats', () => {
    for (const [value, unit, signed] of [['0', 'g', false], ['0.001', 'ml', false], ['10', 'piece', false], ['-0.001', 'g', true]] as const) expect(validQuantity(value, unit, signed)).toBe(true);
    for (const [value, unit] of [['-0', 'g'], ['-1', 'g'], ['1e2', 'g'], ['1.5', 'piece'], ['1.0001', 'ml'], ['9007199254740992', 'g'], ['NaN', 'g']] as const) expect(validQuantity(value, unit)).toBe(false);
    expect(comparableCost(null, 'g', 'USD')).toBe('Unknown');
    expect(comparableCost('0.012000000', 'g', 'USD')).toBe('$12.00 / kg');
    expect(comparableCost('0.000000000', 'piece', 'USD')).toBe('$0.00 / piece');
    expect(comparableCost('0.000000001', 'g', 'USD')).toBe('$0.000001 / kg');
  });
  it('accepts valid linked responses and operation identity', async () => {
    const {api, ingredient, preview, draft, result} = await data();
    expect(checkedIngredient(ingredient)).toEqual(ingredient);
    expect(checkedPurchasePreview(preview, draft)).toEqual(preview);
    expect(checkedPurchase(result.purchase)).toEqual(result.purchase);
    const movements = await api.request<any>(`/ingredients/${ingredient.id}/movements`); expect(checkedMovement(movements.items[0])).toEqual(movements.items[0]);
    const prices = await api.request<any>(`/ingredients/${ingredient.id}/prices`); expect(checkedPrice(prices.items[0])).toEqual(prices.items[0]);
    const body = {expected_version: 2, type: 'waste', delta_base_quantity: '-10', reason: 'Spill', preparation_id: null, corrects_movement_id: null};
    const movementPreview = await api.request<any>(`/ingredients/${ingredient.id}/movement-preview`, {method: 'POST', body}); expect(checkedMovementPreview(movementPreview)).toEqual(movementPreview);
    expect(checkedInventoryOperation(await api.request('/operations/purchase'), 'purchase').result?.body).toEqual(result);
  });
  it('rejects malformed stock, permissions, cost, quantity, totals, preview identity and operation IDs', async () => {
    const {api, ingredient, preview, draft, result} = await data();
    for (const changes of [{stock_on_hand: '-1'}, {base_unit: 'kg'}, {version: 0}, {latest_unit_cost: 'NaN'}, {low_stock: false}, {latest_unit_cost: '0.000000000'}, {permitted_actions: {}}]) expect(() => checkedIngredient({...ingredient, ...changes})).toThrow();
    for (const changes of [{items: []}, {total_cost_minor: 1}, {currency: 'invalid'}, {minor_digits: 10}, {recorded_at: 'today'}]) expect(() => checkedPurchase({...result.purchase, ...changes})).toThrow();
    expect(() => checkedPurchasePreview({...preview, items: [{...preview.items[0], client_line_id: 'other'}]}, draft)).toThrow();
    expect(() => checkedPurchasePreview({...preview, items: [{...preview.items[0], after_quantity: '-1'}]}, draft)).toThrow();
    const operation = await api.request<any>('/operations/purchase');
    expect(() => checkedInventoryOperation(operation, 'another')).toThrow();
    expect(() => checkedInventoryOperation({...operation, resource_id: 'another'}, 'purchase')).toThrow();
    expect(() => checkedInventoryOperation({...operation, state: 'processing'}, 'purchase')).toThrow();
  });
});
