import {beforeAll, describe, expect, it} from 'vitest';
import {createFixtureTransport} from '../src/api/fixtures';
import {createApiClient} from '../src/api/client';
import {seedOrder} from './order-helpers';
import {checkedOrder, checkedQuote, checkedSummary, checkedDashboard, checkedOrderOperation} from '../src/orders/responses';
import type {Order, Quote, Dashboard} from '../src/orders/types';
let order: Order; let quote: Quote; let dashboard: Dashboard;
beforeAll(async () => {
  const fixture = createFixtureTransport({latency: 0}); order = await seedOrder(fixture.fetch);
  const api = createApiClient({baseUrl: '/api/v1', transport: fixture.fetch});
  const session = await api.request<{csrf_token: string}>('/auth/sign-in', {method: 'POST', body: {username: 'admin', token: 'local-admin-token'}}); api.setCsrfToken(session.csrf_token);
  const {fulfillment_at: _at, pickup_location: _pickup, ...fulfillment} = order.fulfillment;
  const draft = {customer: order.customer, fulfillment, items: order.items.map(item => ({client_line_id: item.id, order_item_id: item.id, variant_id: item.variant_id, quantity: item.quantity, preparation_notes: item.preparation_notes})), notes: order.notes, tax_minor: 0, delivery_charge_minor: 0};
  quote = await api.request('/orders/quote', {method: 'POST', body: {order_id: order.id, expected_version: order.version, draft}});
  dashboard = await api.request('/dashboard?date=2026-10-10');
});
describe('authoritative order response validation', () => {
  it('accepts complete snapshots, quotes, summaries and dashboard responses', () => {
    expect(checkedOrder(order)).toEqual(order); expect(checkedQuote(quote)).toEqual(quote);
    expect(checkedSummary(dashboard.today.items[0])).toEqual(dashboard.today.items[0]); expect(checkedDashboard(dashboard)).toEqual(dashboard);
  });
  it.each([{total_minor: -1}, {balance_due_minor: 0.5}, {subtotal_minor: Number.MAX_SAFE_INTEGER + 1}, {currency: 'bad'}, {status: 'unknown'}, {items: []}, {permitted_actions: {}}, {version: 0}, {status_history: []}])('rejects invalid order %j', change => {
    expect(() => checkedOrder({...order, ...change})).toThrow();
  });
  it('rejects malformed snapshots and fulfillment instead of presenting fabricated values', () => {
    expect(() => checkedOrder({...order, items: [{...order.items[0], unit_price_minor: '8000'}]})).toThrow();
    expect(() => checkedOrder({...order, items: [{...order.items[0], selling_unit: 'package', package_contents: null}]})).toThrow();
    expect(() => checkedOrder({...order, fulfillment: {...order.fulfillment, timezone: ''}})).toThrow();
    expect(() => checkedOrder({...order, items: [order.items[0], order.items[0]]})).toThrow();
  });
  it.each([{expires_at: 'invalid'}, {lines: []}, {total_minor: NaN}, {credit_acknowledgment_required: 'yes'}, {settings_version: 0}])('rejects invalid quote %j', change => {
    expect(() => checkedQuote({...quote, ...change})).toThrow();
  });
  it('rejects duplicate quote lines, invalid summaries and incomplete dashboard collections', () => {
    expect(() => checkedQuote({...quote, lines: [quote.lines[0], quote.lines[0]]})).toThrow();
    expect(() => checkedSummary({...dashboard.today.items[0], fulfillment_local_date: '2026-02-30'})).toThrow();
    expect(() => checkedDashboard({...dashboard, upcoming: null})).toThrow();
  });
  it('validates a reconciled operation against its UUID, resource identity and complete order', () => {
    const operation = {operation_id: 'op', state: 'succeeded', resource_type: 'order', resource_id: order.id,
      result: {http_status: 201, body: order}, error: null, started_at: order.created_at, completed_at: order.updated_at};
    expect(checkedOrderOperation(operation, 'op')).toEqual(operation);
    expect(() => checkedOrderOperation(operation, 'different')).toThrow();
    expect(() => checkedOrderOperation({...operation, resource_id: 'wrong'}, 'op')).toThrow();
    expect(() => checkedOrderOperation({...operation, result: {http_status: 201, body: {...order, total_minor: '21500'}}}, 'op')).toThrow();
    expect(() => checkedOrderOperation({...operation, state: 'unknown'}, 'op')).toThrow();
  });
});
