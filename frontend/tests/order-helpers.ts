import type { FetchTransport, Food, PageResult } from '../src/api/types';
import type { Order, OrderDraft } from '../src/orders/types';
import { createApiClient } from '../src/api/client';
export async function seedOrder(transport: FetchTransport, changes: Partial<OrderDraft> = {}, status = 'confirmed'): Promise<Order> {
  const api = createApiClient({baseUrl: '/api/v1', transport});
  const session = await api.request<{csrf_token: string}>('/auth/sign-in', {method: 'POST', body: {username: 'admin', token: 'local-admin-token'}});
  api.setCsrfToken(session.csrf_token);
  const menu = await api.request<PageResult<Food>>('/foods?limit=100');
  const medium = menu.items.find(food => food.name === 'Beef Caldereta')!.variants.find(variant => variant.label === 'Medium')!;
  const shanghai = menu.items.find(food => food.name === 'Shanghai Spring Rolls')!.variants[0];
  const draft: OrderDraft = {customer: {name: 'Sample Customer', phone: '555-0100', notes: 'Contact notes'},
    fulfillment: {method: 'pickup', local_date: '2026-10-10', local_time: '12:00', timezone: 'America/Los_Angeles', utc_offset: null, address: null},
    items: [{client_line_id: 'sample-line1', variant_id: medium.id, quantity: 2, preparation_notes: 'Mild'}, {client_line_id: 'sample-line2', variant_id: shanghai.id, quantity: 1, preparation_notes: ''}],
    notes: 'Order notes', delivery_charge_minor: 0, tax_minor: 0, ...changes};
  const quote = await api.request<{id: string}>('/orders/quote', {method: 'POST', body: {draft}});
  const order = await api.request<Order>('/orders', {method: 'POST', operationId: crypto.randomUUID(), body: {quote_id: quote.id, draft, initial_status: status, acknowledge_credit: false}});
  await api.request('/auth/sign-out', {method: 'POST', body: {}});
  return order;
}
