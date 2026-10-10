import {createApiClient} from '../src/api/client';
import {createFixtureTransport} from '../src/api/fixtures';
import {seedOrder} from './order-helpers';
import type {Order, OrderDraft} from '../src/orders/types';
export function draftFor(order: Order): OrderDraft {
  const {fulfillment_at: _at, pickup_location: _location, ...fulfillment} = order.fulfillment;
  return {customer: order.customer, fulfillment, items: order.items.map(item => ({client_line_id: item.id, order_item_id: item.id,
    variant_id: item.variant_id, quantity: item.quantity, preparation_notes: item.preparation_notes})), notes: order.notes,
    tax_minor: order.tax_minor, delivery_charge_minor: order.delivery_charge_minor};
}
export async function financialApi(status: 'pending' | 'confirmed' = 'confirmed') {
  const fixture = createFixtureTransport({latency: 0}); const order = await seedOrder(fixture.fetch, {}, status);
  const api = createApiClient({baseUrl: '/api/v1', transport: fixture.fetch});
  const session = await api.request<{csrf_token: string}>('/auth/sign-in', {method: 'POST', body: {username: 'admin', token: 'local-admin-token'}}); api.setCsrfToken(session.csrf_token);
  const payment = (version = 1, amount = 18000, key: string = crypto.randomUUID()) => api.request<any>(`/orders/${order.id}/payments`, {method: 'POST', operationId: key,
    body: {expected_version: version, amount_minor: amount, paid_on: '2026-10-07', method: 'cash', reference: 'Receipt 42', note: 'Deposit'}});
  return {fixture, api, order, payment};
}
