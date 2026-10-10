import {describe, expect, it} from 'vitest';
import {createApiClient} from '../src/api/client';
import {createFixtureTransport} from '../src/api/fixtures';
import {createInventoryFixtures} from '../src/api/inventory-fixtures';
import {sampleSettings} from './helpers';

export async function inventoryApi() {
  const transport = createFixtureTransport({latency: 0});
  const api = createApiClient({baseUrl: '/api/v1', transport: transport.fetch});
  const session = await api.request<{csrf_token: string}>('/auth/sign-in', {method: 'POST', body: {username: 'admin', token: 'local-admin-token'}});
  api.setCsrfToken(session.csrf_token);
  return {api, transport};
}
const ingredient = (api: any, base_unit = 'g', name = 'Flour') => api.request('/ingredients', {method: 'POST', operationId: crypto.randomUUID(), body: {name, base_unit, low_stock_threshold: '100'}});
const line = (id: string, changes = {}) => ({client_line_id: crypto.randomUUID(), ingredient_id: id, quantity: '2', unit: 'kg', pack_contents: null, total_cost_minor: 2400, ...changes});
const draft = (items: any[], changes = {}) => ({purchased_on: '2026-10-07', supplier: 'Market', note: '', items, ...changes});
async function purchase(api: any, body: any) {
  const preview = await api.request('/purchases/preview', {method: 'POST', body: {draft: body}});
  const request = {method: 'POST', operationId: crypto.randomUUID(), body: {preview_id: preview.id, draft: body}};
  return {preview, request, result: await api.request('/purchases', request)};
}

describe('inventory and purchase development contract', () => {
  it.each([
    ['ml',{quantity:'1.5',unit:'l'},'1500'], ['ml',{quantity:'2',unit:'bottle',pack_contents:{quantity:'250',unit:'ml'}},'500'],
    ['piece',{quantity:'2',unit:'box',pack_contents:{quantity:'12',unit:'piece'}},'24'], ['g',{quantity:'0.001',unit:'g'},'0.001'],
  ])('normalizes compatible %s purchases exactly',async(base,changes,expected)=>{
    const {api}=await inventoryApi();const item=await ingredient(api,String(base));const {result}=await purchase(api,draft([line(item.id,changes as object)]));expect(result.ingredients[0].stock_on_hand).toBe(expected);
  });
  it('rejects fractional pieces, unsafe receipt totals, invalid dates and unknown fields without stock effects',async()=>{
    const {api}=await inventoryApi();const egg=await ingredient(api,'piece');
    for(const body of [draft([line(egg.id,{unit:'piece',quantity:'1.5'})]),draft([line(egg.id,{unit:'piece',total_cost_minor:Number.MAX_SAFE_INTEGER}),line(egg.id,{unit:'piece'})]),draft([line(egg.id,{unit:'piece'})],{purchased_on:'2026-02-30'}),draft([line(egg.id,{unit:'piece',unexpected:true})])]) await expect(api.request('/purchases/preview',{method:'POST',body:{draft:body}})).rejects.toMatchObject({status:422});
    await expect(api.request('/purchases?date_from=2026-10-08&date_to=2026-10-07')).rejects.toMatchObject({status:422});await expect(api.request(`/ingredients/${egg.id}`)).resolves.toMatchObject({stock_on_hand:'0'});
  });
  it('admits simultaneous identical operation keys only once, with an immutable successful replay', async () => {
    const handler = createInventoryFixtures({...sampleSettings, capabilities: {...sampleSettings.capabilities, inventory:true,purchases:true}}, new Map());
    const request = {method:'POST', headers:{'Idempotency-Key':'concurrent-key'}, body:JSON.stringify({name:'Flour',base_unit:'g'})};
    const [a,b] = await Promise.all([handler(new URL('http://fixture/api/v1/ingredients'),request),handler(new URL('http://fixture/api/v1/ingredients'),request)]);
    expect(await a!.json()).toEqual(await b!.json());
    const list = await handler(new URL('http://fixture/api/v1/ingredients')); expect(await list!.json()).toMatchObject({total:1});
  });
  it('enables capability navigation and creates searchable ingredients with unknown, not zero, cost', async () => {
    const {api} = await inventoryApi();
    await expect(api.request('/settings')).resolves.toMatchObject({capabilities: {inventory: true, purchases: true}});
    const flour = await ingredient(api);
    expect(flour).toMatchObject({version: 1, name: 'Flour', stock_on_hand: '0', low_stock: true, latest_unit_cost: null, latest_purchase_date: null});
    await ingredient(api, 'ml', 'Oil'); await ingredient(api, 'piece', 'Egg');
    await expect(api.request('/ingredients?q=flour&low_stock=true')).resolves.toMatchObject({total: 1, items: [flour]});
    await expect(api.request('/ingredients?limit=1&page=2')).resolves.toMatchObject({total: 3, has_next: true});
    await expect(api.request('/ingredients?q=missing')).resolves.toMatchObject({items: [], total: 0});
    await expect(api.request('/ingredients?low_stock=wrong')).rejects.toMatchObject({status: 422});
    await expect(api.request('/ingredients?unknown=x')).rejects.toMatchObject({status: 422});
    const updated = await api.request(`/ingredients/${flour.id}`, {method: 'PATCH', operationId: 'edit', body: {expected_version: 1, name: 'Bread flour', low_stock_threshold: null}});
    expect(updated).toMatchObject({version: 2, low_stock: false, low_stock_threshold: null});
    await expect(api.request(`/ingredients/${flour.id}`, {method: 'PATCH', operationId: 'stale', body: {expected_version: 1, name: 'Overwrite'}})).rejects.toMatchObject({code: 'version_conflict', details: {latest_resource: updated}});
  });
  it.each(['-0', '-1', '1e3', 'NaN', '1.0001', '9007199254740992'])('rejects invalid threshold %s', async value => {
    const {api} = await inventoryApi();
    await expect(api.request('/ingredients', {method: 'POST', operationId: value, body: {name: 'Invalid', base_unit: 'g', low_stock_threshold: value}})).rejects.toMatchObject({status: 422});
  });
  it('normalizes 2kg/$24, saves an immutable receipt, stock and comparable price history', async () => {
    const {api} = await inventoryApi(); const flour = await ingredient(api);
    const {preview, result, request} = await purchase(api, draft([line(flour.id)]));
    expect(preview).toMatchObject({currency: 'USD', minor_digits: 2, total_cost_minor: 2400, items: [expect.objectContaining({base_quantity: '2000', unit_cost: '0.012000000', ingredient_version: 1})]});
    expect(result.ingredients[0]).toMatchObject({stock_on_hand: '2000', version: 2, low_stock: false, latest_unit_cost: '0.012000000', latest_purchase_date: '2026-10-07'});
    expect(result.purchase).toMatchObject({total_cost_minor: 2400, items: [expect.objectContaining({ingredient_name: 'Flour', quantity: '2', unit: 'kg', base_quantity: '2000'})]});
    await expect(api.request(`/purchases/${result.purchase.id}`)).resolves.toEqual(result.purchase);
    await expect(api.request('/purchases?q=market&supplier=Market&date_from=2026-10-07&date_to=2026-10-07')).resolves.toMatchObject({total: 1});
    const prices = await api.request<any>(`/ingredients/${flour.id}/prices`);
    expect(prices.items[0]).toMatchObject({purchase_id: result.purchase.id, supplier: 'Market', unit_cost: '0.012000000', base_quantity: '2000'});
    const movements = await api.request<any>(`/ingredients/${flour.id}/movements`);
    expect(movements.items[0]).toMatchObject({type: 'purchase', purchase_id: result.purchase.id, before_quantity: '0', after_quantity: '2000'});
    await expect(api.request('/purchases', request)).resolves.toEqual(result);
    await expect(api.request(`/ingredients/${flour.id}`)).resolves.toMatchObject({stock_on_hand: '2000', version: 2});
    await expect(api.request(`/operations/${request.operationId}`)).resolves.toMatchObject({state: 'succeeded', resource_type: 'purchase', result: {body: result}});
    await expect(api.request('/purchases', {...request, body: {...request.body, draft: {...request.body.draft, supplier: 'Changed'}}})).rejects.toMatchObject({code: 'operation_payload_mismatch'});
  });
  it('normalizes declared packs and repeated rows, but rejects incompatible dimensions atomically', async () => {
    const {api} = await inventoryApi(); const flour = await ingredient(api); const oil = await ingredient(api, 'ml');
    const {result} = await purchase(api, draft([line(flour.id, {quantity: '3', unit: 'bag', pack_contents: {quantity: '500', unit: 'g'}}), line(flour.id, {quantity: '0.5'})]));
    expect(result.purchase.items.map((row: any) => row.base_quantity)).toEqual(['1500', '500']);
    expect(result.ingredients).toHaveLength(1); expect(result.ingredients[0]).toMatchObject({stock_on_hand: '2000', version: 2});
    await expect(api.request('/purchases/preview', {method: 'POST', body: {draft: draft([line(flour.id), line(oil.id)])}})).rejects.toMatchObject({status: 422, fieldErrors: expect.arrayContaining([expect.objectContaining({path: '/draft/items/1/unit'})])});
    await expect(api.request(`/ingredients/${oil.id}`)).resolves.toMatchObject({stock_on_hand: '0'});
  });
  it.each([
    {quantity: '1.5', unit: 'box', pack_contents: {quantity: '5', unit: 'g'}},
    {unit: 'bag'}, {quantity: '0'}, {total_cost_minor: -1}, {total_cost_minor: Number.MAX_SAFE_INTEGER + 1},
    {quantity: '1.0001'}, {unit: 'piece'}, {pack_contents: {quantity: '5', unit: 'g'}},
  ])('rejects invalid purchase line %j', async changes => {
    const {api} = await inventoryApi(); const flour = await ingredient(api);
    await expect(api.request('/purchases/preview', {method: 'POST', body: {draft: draft([line(flour.id, changes)])}})).rejects.toMatchObject({status: 422});
    await expect(api.request(`/ingredients/${flour.id}`)).resolves.toMatchObject({stock_on_hand: '0'});
  });
  it('retains the latest business-date cost, distinguishes zero and leaves costs unchanged after waste', async () => {
    const {api} = await inventoryApi(); const flour = await ingredient(api);
    await purchase(api, draft([line(flour.id)]));
    await purchase(api, draft([line(flour.id, {total_cost_minor: 0})], {purchased_on: '2026-10-06'}));
    let current = await api.request<any>(`/ingredients/${flour.id}`);
    expect(current.latest_unit_cost).toBe('0.012000000');
    const body = {expected_version: current.version, type: 'waste', delta_base_quantity: '-10', reason: 'Spilled', preparation_id: null, corrects_movement_id: null};
    const preview = await api.request<any>(`/ingredients/${flour.id}/movement-preview`, {method: 'POST', body});
    const moved = await api.request<any>(`/ingredients/${flour.id}/movements`, {method: 'POST', operationId: 'waste', body: {...body, preview_id: preview.id}});
    expect(moved.ingredient).toMatchObject({stock_on_hand: '3990', latest_unit_cost: '0.012000000'});
    await purchase(api, draft([line(flour.id, {total_cost_minor: 0})], {purchased_on: '2026-10-08'}));
    current = await api.request<any>(`/ingredients/${flour.id}`); expect(current.latest_unit_cost).toBe('0.000000000');
    const prices = await api.request<any>(`/ingredients/${flour.id}/prices`); expect(prices.total).toBe(3); expect(prices.items[0].purchased_on).toBe('2026-10-08');
  });
  it('previews reasoned opening/waste/correction, appends links, and rejects negative stock or repeated opening', async () => {
    const {api} = await inventoryApi(); const egg = await ingredient(api, 'piece');
    let body = {expected_version: 1, type: 'opening', delta_base_quantity: '10', reason: 'Counted opening', preparation_id: null, corrects_movement_id: null};
    let preview = await api.request<any>(`/ingredients/${egg.id}/movement-preview`, {method: 'POST', body});
    expect(preview).toMatchObject({before_quantity: '0', after_quantity: '10'});
    const opening = await api.request<any>(`/ingredients/${egg.id}/movements`, {method: 'POST', operationId: 'opening', body: {...body, preview_id: preview.id}});
    await expect(api.request(`/ingredients/${egg.id}/movement-preview`, {method: 'POST', body: {...body, expected_version: 2}})).rejects.toMatchObject({status: 422});
    for (const change of [{type: 'waste', delta_base_quantity: '-11'}, {type: 'correction', delta_base_quantity: '1.5'}, {type: 'correction', reason: ''}, {type: 'waste', delta_base_quantity: '1'}]) {
      await expect(api.request(`/ingredients/${egg.id}/movement-preview`, {method: 'POST', body: {...body, expected_version: 2, ...change}})).rejects.toMatchObject({status: 422});
    }
    body = {...body, type: 'correction', expected_version: 2, delta_base_quantity: '-2', reason: 'Recount', corrects_movement_id: opening.movement.id};
    preview = await api.request<any>(`/ingredients/${egg.id}/movement-preview`, {method: 'POST', body});
    const request = {method: 'POST', operationId: 'correction', body: {...body, preview_id: preview.id}};
    const correction = await api.request<any>(`/ingredients/${egg.id}/movements`, request);
    expect(correction).toMatchObject({ingredient: {version: 3, stock_on_hand: '8'}, movement: {corrects_movement_id: opening.movement.id, before_quantity: '10', after_quantity: '8'}});
    await expect(api.request(`/ingredients/${egg.id}/movements`, request)).resolves.toEqual(correction);
    await expect(api.request(`/ingredients/${egg.id}/movements`)).resolves.toMatchObject({total: 2});
  });
  it('binds previews to exact inputs and versions and rejects expired/concurrent saves without partial effects', async () => {
    const {api} = await inventoryApi(); const flour = await ingredient(api); const oil = await ingredient(api, 'ml');
    const body = draft([line(flour.id), line(oil.id, {unit: 'l'})]);
    const preview = await api.request<any>('/purchases/preview', {method: 'POST', body: {draft: body}});
    await expect(api.request('/purchases', {method: 'POST', operationId: 'changed', body: {preview_id: preview.id, draft: {...body, note: 'Changed'}}})).rejects.toMatchObject({code: 'quote_stale'});
    await purchase(api, draft([line(flour.id)]));
    await expect(api.request('/purchases', {method: 'POST', operationId: 'concurrent', body: {preview_id: preview.id, draft: body}})).rejects.toMatchObject({code: 'version_conflict'});
    await expect(api.request(`/ingredients/${oil.id}`)).resolves.toMatchObject({stock_on_hand: '0'});
    const expiring = await api.request<any>('/purchases/preview', {method: 'POST', body: {draft: body}});
    const original = Date.now; Date.now = () => original() + 301000;
    try {await expect(api.request('/purchases', {method: 'POST', operationId: 'expired', body: {preview_id: expiring.id, draft: body}})).rejects.toMatchObject({code: 'quote_stale'});} finally {Date.now = original;}
  });
});
