import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client';
import { createFixtureTransport } from '../src/api/fixtures';

export async function orderApi() {
  const fixture = createFixtureTransport({latency: 0});
  const api = createApiClient({baseUrl: '/api/v1', transport: fixture.fetch});
  const session = await api.request<{csrf_token: string}>('/auth/sign-in', {method: 'POST', body: {username: 'admin', token: 'local-admin-token'}});
  api.setCsrfToken(session.csrf_token);
  const menu = await api.request<any>('/foods?limit=100');
  const medium = menu.items.find((food: any) => food.name === 'Beef Caldereta').variants.find((variant: any) => variant.label === 'Medium');
  const shanghai = menu.items.find((food: any) => food.name === 'Shanghai Spring Rolls').variants[0];
  const draft = {
    customer: {name: 'Sample Customer', phone: '555-0100', notes: 'Contact notes'},
    fulfillment: {method: 'pickup', local_date: '2026-10-10', local_time: '12:00', timezone: 'America/Los_Angeles', utc_offset: null, address: null},
    items: [{client_line_id: 'line1', variant_id: medium.id, quantity: 2, preparation_notes: 'Mild'},
      {client_line_id: 'line2', variant_id: shanghai.id, quantity: 1, preparation_notes: ''}],
    notes: 'Order notes', delivery_charge_minor: 0, tax_minor: 0,
  };
  const create = async (body = draft, key: string = crypto.randomUUID(), status = 'confirmed') => {
    const quote = await api.request<any>('/orders/quote', {method: 'POST', body: {draft: body}});
    return api.request<any>('/orders', {method: 'POST', operationId: key, body: {quote_id: quote.id, draft: body, initial_status: status, acknowledge_credit: false}});
  };
  return {api, fixture, draft, medium, shanghai, create};
}

describe('reservation development contract', () => {
  it('quotes $215, creates confirmed snapshots/history, and deduplicates a saved response', async () => {
    const {api, draft} = await orderApi();
    await expect(api.request('/settings')).resolves.toMatchObject({capabilities: {orders: true}});
    const quote = await api.request<any>('/orders/quote', {method: 'POST', body: {draft}});
    expect(quote).toMatchObject({subtotal_minor: 21500, total_minor: 21500, balance_due_minor: 21500, currency: 'USD', minor_digits: 2});
    expect(quote.lines[0]).toMatchObject({food_name: 'Beef Caldereta', variant_label: 'Medium', quantity: 2, unit_price_minor: 8000, line_total_minor: 16000});
    expect(quote.lines[1]).toMatchObject({selling_unit: 'package', package_contents: {quantity: 100, unit: 'piece'}, quantity: 1});
    const request = {method: 'POST', operationId: 'order-once', body: {quote_id: quote.id, draft, initial_status: 'confirmed', acknowledge_credit: false}};
    const order = await api.request<any>('/orders', request);
    expect(order).toMatchObject({version: 1, status: 'confirmed', payment_status: 'unpaid', total_minor: 21500, customer: draft.customer});
    expect(order.status_history.map((event: any) => event.to_status)).toEqual(['pending', 'confirmed']);
    await expect(api.request('/orders', request)).resolves.toEqual(order);
    await expect(api.request('/operations/order-once')).resolves.toMatchObject({state: 'succeeded', resource_type: 'order', resource_id: order.id});
    await expect(api.request('/orders')).resolves.toMatchObject({total: 1});
    await expect(api.request('/orders', {...request, body: {...request.body, initial_status: 'pending'}})).rejects.toMatchObject({code: 'operation_payload_mismatch'});
  });

  it('keeps agreed names, units and prices after menu edits; permits decreases on unavailable saved lines only', async () => {
    const {api, create, draft, medium} = await orderApi();
    const order = await create();
    await api.request(`/variants/${medium.id}`, {method: 'PATCH', operationId: 'menu-reprice', body: {expected_version: medium.version, label: 'Changed label', price_minor: 9900, available: false}});
    const food = await api.request<any>('/foods/fixture_caldereta');
    await api.request('/foods/fixture_caldereta', {method: 'PATCH', operationId: 'menu-rename', body: {expected_version: food.version, name: 'New menu name', available: false}});
    await expect(api.request(`/orders/${order.id}`)).resolves.toMatchObject({total_minor: 21500, items: expect.arrayContaining([expect.objectContaining({food_name: 'Beef Caldereta', variant_label: 'Medium', unit_price_minor: 8000})])});
    const edit = {...draft, items: order.items.map((item: any, index: number) => ({client_line_id: `saved-${index}`, order_item_id: item.id, variant_id: item.variant_id, quantity: index === 0 ? 1 : 1, preparation_notes: 'Retained price'}))};
    const quote = await api.request<any>('/orders/quote', {method: 'POST', body: {order_id: order.id, expected_version: 1, draft: edit}});
    expect(quote.total_minor).toBe(13500);
    const updated = await api.request<any>(`/orders/${order.id}`, {method: 'PUT', operationId: 'edit-order', body: {expected_version: 1, quote_id: quote.id, draft: edit, acknowledge_credit: false}});
    expect(updated).toMatchObject({version: 2, status: 'confirmed', total_minor: 13500});
    await expect(api.request('/orders/quote', {method: 'POST', body: {order_id: order.id, expected_version: 2,
      draft: {...edit, items: edit.items.map((item: any, index: number) => ({...item, quantity: index === 0 ? 2 : 1}))}}})).rejects.toMatchObject({status: 422});
    await expect(api.request(`/variants/${medium.id}`, {method: 'PATCH', operationId: 'identity-change', body: {expected_version: 2, selling_unit: 'piece'}})).rejects.toMatchObject({status: 422});
  });

  it('requires fresh reviewed quotes after price changes/expiry and retains atomic order versions', async () => {
    const {api, draft, medium, create} = await orderApi();
    const quote = await api.request<any>('/orders/quote', {method: 'POST', body: {draft}});
    await api.request(`/variants/${medium.id}`, {method: 'PATCH', operationId: 'new-price', body: {expected_version: 1, price_minor: 9000}});
    await expect(api.request('/orders', {method: 'POST', operationId: 'stale-quote', body: {quote_id: quote.id, draft, initial_status: 'pending', acknowledge_credit: false}})).rejects.toMatchObject({code: 'quote_stale'});
    await expect(api.request('/orders')).resolves.toMatchObject({total: 0});
    const order = await create(draft, 'first-order', 'pending');
    const edit = {...draft, items: order.items.map((item: any, index: number) => ({client_line_id: `edit-${index}`, order_item_id: item.id, variant_id: item.variant_id, quantity: item.quantity, preparation_notes: ''}))};
    const first = await api.request<any>('/orders/quote', {method: 'POST', body: {order_id: order.id, expected_version: 1, draft: edit}});
    await api.request(`/orders/${order.id}`, {method: 'PUT', operationId: 'staff-a', body: {expected_version: 1, quote_id: first.id, draft: edit, acknowledge_credit: false}});
    await expect(api.request(`/orders/${order.id}`, {method: 'PUT', operationId: 'staff-b', body: {expected_version: 1, quote_id: first.id, draft: edit, acknowledge_credit: false}}))
      .rejects.toMatchObject({code: 'version_conflict', details: {latest_resource: expect.objectContaining({version: 2})}});
    await expect(api.request(`/orders/${order.id}`)).resolves.toMatchObject({version: 2});
  });

  it('supports pending creation and reviewed confirmation before preparation', async () => {
    const {api, create} = await orderApi();
    const order = await create(undefined, 'pending-create', 'pending');
    expect(order.permitted_actions.confirm.allowed).toBe(true);
    await expect(api.request(`/orders/${order.id}/transitions`, {method: 'POST', operationId: 'confirm', body: {expected_version: 1, to_status: 'confirmed'}}))
      .resolves.toMatchObject({version: 2, status: 'confirmed', status_history: expect.arrayContaining([expect.objectContaining({to_status: 'confirmed'})])});
    await expect(api.request(`/orders/${order.id}/transitions`, {method: 'POST', operationId: 'skip-preparation', body: {expected_version: 2, to_status: 'ready'}})).rejects.toMatchObject({status: 409});
  });

  it('filters customer/reference, business dates/status, chronological sort and pagination; groups dashboard in business time', async () => {
    const {api, create, draft} = await orderApi();
    const first = await create({...draft, customer: {...draft.customer, name: 'Alice'}, fulfillment: {...draft.fulfillment, local_date: '2026-10-10'}}, 'a', 'pending');
    const second = await create({...draft, customer: {...draft.customer, name: 'Bob'}, fulfillment: {...draft.fulfillment, local_date: '2026-10-11'}}, 'b');
    await expect(api.request('/orders?q=alice&date_from=2026-10-10&date_to=2026-10-10&status=pending')).resolves.toMatchObject({total: 1, items: [expect.objectContaining({id: first.id, customer_name: 'Alice'})]});
    await expect(api.request(`/orders?q=${first.reference}`)).resolves.toMatchObject({total: 1});
    await expect(api.request('/orders?sort=fulfillment_desc&limit=1')).resolves.toMatchObject({has_next: true, items: [expect.objectContaining({id: second.id})]});
    await expect(api.request('/orders?limit=1&page=2')).resolves.toMatchObject({page: 2, items: [expect.objectContaining({id: second.id})]});
    const dashboard = await api.request<any>('/dashboard?date=2026-10-10');
    expect(dashboard).toMatchObject({business_date: '2026-10-10', timezone: 'America/Los_Angeles', today: {total: 1}, upcoming: {total: 1}});
    expect(dashboard.today.items[0].fulfillment_at).toBe('2026-10-10T19:00:00Z');
    await expect(api.request('/orders?date_from=2026-10-11&date_to=2026-10-10')).rejects.toMatchObject({status: 422});
    await expect(api.request('/orders?status=unknown')).rejects.toMatchObject({status: 422});
  });

  it('validates delivery, customer, integer quantities, money bounds and DST; never creates from an invalid quote', async () => {
    const {api, draft} = await orderApi();
    for (const body of [
      {...draft, customer: {...draft.customer, name: ''}},
      {...draft, items: []}, {...draft, items: [{...draft.items[0], quantity: 0.5}]},
      {...draft, items: [{...draft.items[0], quantity: Number.MAX_SAFE_INTEGER}]},
      {...draft, delivery_charge_minor: 100},
      {...draft, fulfillment: {...draft.fulfillment, method: 'delivery', address: ''}},
      {...draft, fulfillment: {...draft.fulfillment, local_date: '2026-03-08', local_time: '02:30'}},
      {...draft, fulfillment: {...draft.fulfillment, local_date: '2026-11-01', local_time: '01:30'}},
    ]) await expect(api.request('/orders/quote', {method: 'POST', body: {draft: body}})).rejects.toMatchObject({status: 422, fieldErrors: expect.any(Array)});
    const ambiguous = {...draft, fulfillment: {...draft.fulfillment, local_date: '2026-11-01', local_time: '01:30', utc_offset: '-08:00'}};
    await expect(api.request('/orders/quote', {method: 'POST', body: {draft: ambiguous}})).resolves.toMatchObject({fulfillment: {fulfillment_at: '2026-11-01T09:30:00Z', utc_offset: '-08:00'}});
    const delivery = {...draft, delivery_charge_minor: 1000, tax_minor: 500, fulfillment: {...draft.fulfillment, method: 'delivery', address: '123 Sample Street'}};
    await expect(api.request('/orders/quote', {method: 'POST', body: {draft: delivery}})).resolves.toMatchObject({subtotal_minor: 21500, delivery_charge_minor: 1000, tax_minor: 500, total_minor: 23000});
    await expect(api.request('/orders', {method: 'POST', operationId: 'missing-quote', body: {quote_id: 'missing', draft, initial_status: 'confirmed', acknowledge_credit: false}})).rejects.toMatchObject({code: 'quote_stale'});
    await expect(api.request('/orders')).resolves.toMatchObject({total: 0});
  });

  it('rejects expired or modified quotes and shares operation keys across menu/order mutations', async () => {
    const {api, draft, medium} = await orderApi();
    const quote = await api.request<any>('/orders/quote', {method: 'POST', body: {draft}});
    const request = {method: 'POST', operationId: 'expired', body: {quote_id: quote.id, draft, initial_status: 'pending', acknowledge_credit: false}};
    const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 300001);
    await expect(api.request('/orders', request)).rejects.toMatchObject({code: 'quote_stale'}); clock.mockRestore();
    await expect(api.request('/orders', {...request, operationId: 'changed-draft', body: {...request.body, draft: {...draft, notes: 'changed after review'}}})).rejects.toMatchObject({code: 'quote_stale'});
    const fresh = await api.request<any>('/orders/quote', {method: 'POST', body: {draft}});
    await api.request('/orders', {...request, operationId: 'shared-key', body: {...request.body, quote_id: fresh.id}});
    await expect(api.request(`/variants/${medium.id}`, {method: 'PATCH', operationId: 'shared-key', body: {expected_version: 1, price_minor: 9000}})).rejects.toMatchObject({code: 'operation_payload_mismatch'});
  });

  it('rejects unknown body fields and attempted client snapshot prices instead of trusting them', async () => {
    const {api, draft} = await orderApi();
    for (const body of [{draft, unexpected: true}, {draft: {...draft, items: [{...draft.items[0], unit_price_minor: 1}]}}]) {
      await expect(api.request('/orders/quote', {method: 'POST', body})).rejects.toMatchObject({status: 422});
    }
  });

  it('normalizes omitted notes in saved snapshots', async () => {
    const {api, draft, create} = await orderApi();
    const {notes: _customerNotes, ...customer} = draft.customer;
    const optional = {...draft, customer} as typeof draft;
    const order = await create(optional); expect(order.customer.notes).toBe('');
  });
  it('rejects wrong types or oversized customer/notes fields', async () => {
    const {api, draft} = await orderApi();
    for (const change of [{customer: {...draft.customer, name: 'x'.repeat(201)}}, {customer: {...draft.customer, phone: 'x'.repeat(51)}},
      {customer: {...draft.customer, notes: 123}}, {notes: 'x'.repeat(2001)}, {items: [{...draft.items[0], preparation_notes: 123}]}]) {
      await expect(api.request('/orders/quote', {method: 'POST', body: {draft: {...draft, ...change}}})).rejects.toMatchObject({status: 422});
    }
  });

  it('marks a zero settlement paid and recomputes payment status on an edited charge', async () => {
    const {api, draft, create, medium, shanghai} = await orderApi();
    for (const variant of [medium, shanghai]) await api.request(`/variants/${variant.id}`, {method: 'PATCH', operationId: crypto.randomUUID(), body: {expected_version: variant.version, price_minor: 0}});
    const order = await create(); expect(order).toMatchObject({total_minor: 0, balance_due_minor: 0, payment_status: 'paid'});
    const edit = {...draft, tax_minor: 100, items: order.items.map((item: any) => ({client_line_id: item.id, order_item_id: item.id, variant_id: item.variant_id, quantity: item.quantity, preparation_notes: ''}))};
    const quote = await api.request<any>('/orders/quote', {method: 'POST', body: {order_id: order.id, expected_version: order.version, draft: edit}});
    await expect(api.request(`/orders/${order.id}`, {method: 'PUT', operationId: 'zero-to-due', body: {expected_version: order.version, quote_id: quote.id, draft: edit, acknowledge_credit: false}})).resolves.toMatchObject({total_minor: 100, payment_status: 'unpaid'});
  });
});
