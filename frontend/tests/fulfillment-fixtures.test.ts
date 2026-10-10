import {describe, expect, it} from 'vitest';
import {financialApi, draftFor} from './phase4-helpers';
import {createApiClient} from '../src/api/client';
import {createOrderFixtures} from '../src/api/order-fixtures';
import {createMenuFixtures} from '../src/api/menu-fixtures';
import {sampleSettings} from './helpers';
import {seedOrder} from './order-helpers';
import type {Order} from '../src/orders/types';

describe('fulfillment and append-only ledger contract', () => {
  it('rechecks a quoted edit version after asynchronous calculation so a concurrent deposit is not overwritten', async () => {
    let pause = false; let resume!: () => void; let entered!: () => void; const calculating = new Promise<void>(resolve => {entered = resolve;});
    const operations = new Map(); const usedVariants = new Set<string>(); const menu = createMenuFixtures({operations, usedVariants});
    const handler = createOrderFixtures({operations, usedVariants, settings: {...sampleSettings, capabilities: {...sampleSettings.capabilities, orders: true, menu: true, payments: true}}, menu: async (url, init) => {
      if (pause) {entered(); await new Promise<void>(resolve => {resume = resolve;});} return menu(url, init);
    }});
    async function apiTransport(input: RequestInfo | URL, init?: RequestInit) {
      const url = new URL(String(input), 'http://local'); if (url.pathname.includes('/auth/')) return new Response(JSON.stringify({csrf_token: 'test-csrf'}));
      return (await handler(url, init) ?? await menu(url, init))!;
    }
    const api = createApiClient({baseUrl: '/api/v1', transport: apiTransport}); const order = await seedOrder(apiTransport);
    const payment = (version: number, amount: number) => api.request<{order: Order}>(`/orders/${order.id}/payments`, {method: 'POST', operationId: crypto.randomUUID(), body: {expected_version: version, amount_minor: amount, paid_on: '2026-10-07', method: 'cash'}});
    const deposit = await payment(1, 18000); const draft = draftFor(deposit.order); draft.items[0].quantity = 1; draft.tax_minor = 1500;
    const quote = await api.request<{id: string}>('/orders/quote', {method: 'POST', body: {order_id: order.id, expected_version: 2, draft}});
    pause = true; const editing = api.request(`/orders/${order.id}`, {method: 'PUT', operationId: 'racing-edit', body: {expected_version: 2, quote_id: quote.id, draft, acknowledge_credit: true}}); const settled = Promise.allSettled([editing]);
    await calculating; await payment(2, 3500); resume(); const results = await settled;
    expect(results[0]).toMatchObject({status: 'rejected', reason: {code: 'version_conflict'}});
    await expect(api.request(`/orders/${order.id}`)).resolves.toMatchObject({version: 3, total_minor: 21500, net_paid_minor: 21500, customer_credit_minor: 0, payment_status: 'paid'});
  });
  it('offers the next status only, records actor/timestamps, and completes independently of unpaid balance', async () => {
    const {api, order} = await financialApi('pending');
    await expect(api.request('/settings')).resolves.toMatchObject({capabilities: {payments: true}});
    let latest = order;
    for (const [status, action] of [['confirmed', 'confirm'], ['preparing', 'start_preparing'], ['ready', 'mark_ready'], ['completed', 'complete']] as const) {
      expect(latest.permitted_actions[action].allowed).toBe(true);
      latest = await api.request(`/orders/${order.id}/transitions`, {method: 'POST', operationId: crypto.randomUUID(), body: {expected_version: latest.version, to_status: status}});
      expect(latest).toMatchObject({status, balance_due_minor: 21500, payment_status: 'unpaid'});
      expect(latest.status_history.at(-1)).toMatchObject({to_status: status, actor: {display_name: 'Admin'}, changed_at: expect.any(String)});
      expect(latest.items.every(item => item.prepared_quantity === null && item.remaining_quantity === null)).toBe(true);
    }
    expect(latest.permitted_actions.cancel).toMatchObject({allowed: false, reason: expect.any(String)});
    expect(latest.permitted_actions.edit.allowed).toBe(false);
    await expect(api.request(`/orders/${order.id}/transitions`, {method: 'POST', operationId: 'reverse', body: {expected_version: latest.version, to_status: 'pending'}})).rejects.toMatchObject({status: 409});
  });
  it('rejects jumps and cancellation without a reason; preserves paid history and original totals on cancellation', async () => {
    const {api, order, payment} = await financialApi();
    await expect(api.request(`/orders/${order.id}/transitions`, {method: 'POST', operationId: 'jump', body: {expected_version: 1, to_status: 'completed'}})).rejects.toMatchObject({status: 409});
    const deposit = await payment();
    await expect(api.request(`/orders/${order.id}/cancel`, {method: 'POST', operationId: 'no-reason', body: {expected_version: 2, reason: ' ', acknowledge_consumed_stock: false}})).rejects.toMatchObject({status: 422, fieldErrors: [expect.objectContaining({path: '/reason'})]});
    const cancelled = await api.request<any>(`/orders/${order.id}/cancel`, {method: 'POST', operationId: 'cancel', body: {expected_version: 2, reason: 'Customer cancelled', acknowledge_consumed_stock: false}});
    expect(cancelled).toMatchObject({status: 'cancelled', total_minor: 21500, settlement_total_minor: 0, net_paid_minor: 18000, balance_due_minor: 0, customer_credit_minor: 18000, payment_status: 'credit_due', ledger: [deposit.entry]});
    expect(cancelled.status_history.at(-1)).toMatchObject({reason: 'Customer cancelled', to_status: 'cancelled'});
    expect(cancelled.items).toEqual(order.items); expect(cancelled.permitted_actions.record_payment.allowed).toBe(false); expect(cancelled.permitted_actions.refund.allowed).toBe(true);
    await expect(payment(3, 1)).rejects.toMatchObject({status: 403});
  });
  it('records a positive deposit with metadata and rejects invalid, excessive, or forged amounts', async () => {
    const {api, order, payment} = await financialApi();
    for (const amount of [0, -1, 0.5, 21501, Number.MAX_SAFE_INTEGER + 1]) await expect(payment(1, amount)).rejects.toMatchObject({status: 422, fieldErrors: expect.arrayContaining([expect.objectContaining({path: '/amount_minor'})])});
    const saved = await payment();
    expect(saved.order).toMatchObject({version: 2, payments_minor: 18000, refunds_minor: 0, net_paid_minor: 18000, balance_due_minor: 3500, payment_status: 'partial'});
    expect(saved.entry).toMatchObject({type: 'payment', amount_minor: 18000, refundable_minor: 18000, business_date: '2026-10-07', method: 'cash', reference: 'Receipt 42', note: 'Deposit', reason: null, payment_id: null, recorded_by: {display_name: 'Admin'}});
    await expect(api.request(`/orders/${order.id}/payments`, {method: 'POST', operationId: 'forged', body: {expected_version: 2, amount_minor: 1, paid_on: '2026-10-07', method: 'cash', total_minor: 1}})).rejects.toMatchObject({status: 422});
  });
  it('reviews reduced-order credit and refunds separately without changing preparation status', async () => {
    const {api, order, payment} = await financialApi(); const deposit = await payment(); const draft = draftFor(deposit.order);
    draft.items[0].quantity = 1; draft.tax_minor = 1500;
    const quote = await api.request<any>('/orders/quote', {method: 'POST', body: {order_id: order.id, expected_version: 2, draft}});
    expect(quote).toMatchObject({total_minor: 15000, balance_due_minor: 0, customer_credit_minor: 3000, credit_acknowledgment_required: true});
    const body = {expected_version: 2, quote_id: quote.id, draft, acknowledge_credit: false};
    await expect(api.request(`/orders/${order.id}`, {method: 'PUT', operationId: 'unacknowledged', body})).rejects.toMatchObject({status: 422});
    const edit = await api.request<any>(`/orders/${order.id}`, {method: 'PUT', operationId: 'acknowledged', body: {...body, acknowledge_credit: true}});
    expect(edit).toMatchObject({payment_status: 'credit_due', ledger: [deposit.entry]});
    const refund = await api.request<any>(`/orders/${order.id}/refunds`, {method: 'POST', operationId: 'credit-refund', body: {expected_version: 3, payment_id: deposit.entry.id, amount_minor: 3000, refunded_on: '2026-10-07', method: 'bank_transfer', reason: 'Reduced order', reference: 'Transfer 1', note: ''}});
    expect(refund.order).toMatchObject({version: 4, status: 'confirmed', net_paid_minor: 15000, customer_credit_minor: 0, balance_due_minor: 0, payment_status: 'paid'});
    expect(refund.entry).toMatchObject({type: 'refund', amount_minor: 3000, payment_id: deposit.entry.id, reason: 'Reduced order', refundable_minor: null});
    expect(refund.order.ledger[0]).toMatchObject({...deposit.entry, refundable_minor: 15000}); expect(refund.order.ledger).toHaveLength(2);
  });
  it('bounds refunds by the original payment and keeps refund entries immutable', async () => {
    const {api, order, payment} = await financialApi(); const first = await payment(1, 5000); await payment(2, 4000);
    const request = (amount: number, reason = 'Customer request', paymentId = first.entry.id, version = 3) => api.request<any>(`/orders/${order.id}/refunds`, {method: 'POST', operationId: crypto.randomUUID(), body: {expected_version: version, payment_id: paymentId, amount_minor: amount, refunded_on: '2026-10-07', method: 'cash', reason, reference: '', note: ''}});
    for (const amount of [0, -1, 5001]) await expect(request(amount)).rejects.toMatchObject({status: 422});
    await expect(request(1, '')).rejects.toMatchObject({status: 422}); await expect(request(1, 'Reason', 'unknown')).rejects.toMatchObject({status: 422});
    const refunded = await request(2000); expect(refunded.order).toMatchObject({net_paid_minor: 7000, refunds_minor: 2000, balance_due_minor: 14500});
    await expect(request(3001, 'Reason', first.entry.id, 4)).rejects.toMatchObject({status: 422});
    await expect(api.request(`/orders/${order.id}/refunds/${refunded.entry.id}`, {method: 'PATCH', operationId: 'edit-ledger', body: {amount_minor: 1}})).rejects.toMatchObject({status: 404});
  });
  it('deduplicates a payment/refund UUID before stale-version checks and exposes its exact operation response', async () => {
    const {api, order, payment} = await financialApi(); const saved = await payment(1, 5000, 'payment-once');
    await expect(payment(1, 5000, 'payment-once')).resolves.toEqual(saved);
    await expect(payment(1, 5001, 'payment-once')).rejects.toMatchObject({code: 'operation_payload_mismatch'});
    await expect(api.request('/operations/payment-once')).resolves.toMatchObject({state: 'succeeded', resource_type: 'order', resource_id: order.id, result: {http_status: 201, body: saved}});
    const options = {method: 'POST', operationId: 'refund-once', body: {expected_version: 2, payment_id: saved.entry.id, amount_minor: 1000, refunded_on: '2026-10-07', method: 'cash', reason: 'Reason'}};
    const refunded = await api.request(`/orders/${order.id}/refunds`, options); await expect(api.request(`/orders/${order.id}/refunds`, options)).resolves.toEqual(refunded);
    await expect(api.request(`/orders/${order.id}`)).resolves.toMatchObject({ledger: expect.any(Array), payments_minor: 5000, refunds_minor: 1000, version: 3});
  });
  it('rejects the second staff payment and refreshes list/dashboard from the committed balance', async () => {
    const {api, order, payment} = await financialApi();
    const results = await Promise.allSettled([payment(1, 18000), payment(1, 18000)]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(value => value.status === 'rejected')).toMatchObject({reason: {code: 'version_conflict', details: {latest_resource: expect.objectContaining({balance_due_minor: 3500})}}});
    await expect(api.request('/orders')).resolves.toMatchObject({items: [expect.objectContaining({balance_due_minor: 3500, payment_status: 'partial'})]});
    await expect(api.request('/dashboard?date=2026-10-10')).resolves.toMatchObject({today: {items: [expect.objectContaining({balance_due_minor: 3500})]}});
    await expect(api.request(`/orders/${order.id}`)).resolves.toMatchObject({ledger: [expect.objectContaining({amount_minor: 18000})]});
  });
  it('validates dates/methods/reasons and disallows completed cancellation while accepting outstanding payment', async () => {
    const {api, order, payment} = await financialApi();
    for (const body of [{paid_on: '2026-02-30'}, {method: 'unknown'}, {reference: 'x'.repeat(201)}, {note: 'x'.repeat(2001)}]) await expect(api.request(`/orders/${order.id}/payments`, {method: 'POST', operationId: crypto.randomUUID(), body: {expected_version: 1, amount_minor: 100, paid_on: '2026-10-07', method: 'cash', ...body}})).rejects.toMatchObject({status: 422});
    let version = 1; for (const status of ['preparing', 'ready', 'completed']) {await api.request(`/orders/${order.id}/transitions`, {method: 'POST', operationId: crypto.randomUUID(), body: {expected_version: version++, to_status: status}});}
    await expect(api.request(`/orders/${order.id}/cancel`, {method: 'POST', operationId: 'completed-cancel', body: {expected_version: 4, reason: 'Reason', acknowledge_consumed_stock: false}})).rejects.toMatchObject({status: 409});
    await expect(payment(4, 21500)).resolves.toMatchObject({order: {status: 'completed', payment_status: 'paid', balance_due_minor: 0}});
  });
});
