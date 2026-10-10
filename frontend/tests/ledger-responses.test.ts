import {beforeAll, describe, expect, it} from 'vitest';
import {financialApi} from './phase4-helpers';
import {checkedLedgerEntry, checkedLedgerResult, checkedOrder, checkedOrderOperation} from '../src/orders/responses';
import type {LedgerResult} from '../src/orders/types';
let deposit: LedgerResult; let refund: LedgerResult;
beforeAll(async () => {
  const {api, order, payment} = await financialApi(); deposit = await payment(1, 18000, 'deposit-op');
  refund = await api.request(`/orders/${order.id}/refunds`, {method: 'POST', operationId: 'refund-op', body: {expected_version: 2, payment_id: deposit.entry.id, amount_minor: 3000, refunded_on: '2026-10-07', method: 'cash', reason: 'Reason'}});
});
describe('financial response boundaries', () => {
  it('accepts complete payment/refund ledger results and operation wrappers', () => {
    expect(checkedLedgerResult(deposit)).toEqual(deposit); expect(checkedLedgerResult(refund)).toEqual(refund);
    const operation = {operation_id: 'deposit-op', state: 'succeeded', resource_type: 'order', resource_id: deposit.order.id, result: {http_status: 201, body: deposit}, error: null, started_at: deposit.entry.recorded_at, completed_at: deposit.entry.recorded_at};
    expect(checkedOrderOperation(operation, 'deposit-op')).toEqual(operation);
  });
  it('compares audit actors structurally regardless of JSON object key order', () => {
    const entry = {...deposit.entry, recorded_by: {display_name: deposit.entry.recorded_by.display_name, id: deposit.entry.recorded_by.id}};
    expect(checkedLedgerResult({...deposit, entry})).toEqual({...deposit, entry});
  });
  it.each([{amount_minor: 0}, {amount_minor: '18000'}, {amount_minor: -1}, {refundable_minor: 18001}, {business_date: '2026-02-30'}, {method: 'card'}, {recorded_by: null}, {recorded_at: 'yesterday'}, {operation_id: ''}, {reference: null}])('rejects malformed ledger entry %j', change => {
    expect(() => checkedLedgerEntry({...deposit.entry, ...change})).toThrow();
  });
  it('requires refund reason/original identity and payment-specific null fields', () => {
    expect(() => checkedLedgerEntry({...refund.entry, reason: ''})).toThrow(); expect(() => checkedLedgerEntry({...refund.entry, payment_id: null})).toThrow();
    expect(() => checkedLedgerEntry({...refund.entry, refundable_minor: 0})).toThrow(); expect(() => checkedLedgerEntry({...deposit.entry, payment_id: 'other'})).toThrow();
  });
  it('rejects missing, duplicated or inconsistent ledger identities and financial aggregates', () => {
    for (const change of [{ledger: [refund.entry]}, {ledger: [deposit.entry, deposit.entry]}, {net_paid_minor: 1}, {payments_minor: 1}, {balance_due_minor: 0},
      {customer_credit_minor: 1}, {payment_status: 'paid'}, {cancellation_requires_stock_acknowledgment: 'yes'}]) expect(() => checkedOrder({...refund.order, ...change})).toThrow();
    expect(() => checkedOrder({...refund.order, ledger: refund.order.ledger.map(entry => entry.type === 'refund' ? {...entry, payment_id: 'other'} : entry)})).toThrow();
    expect(() => checkedOrder({...refund.order, ledger: refund.order.ledger.map(entry => entry.type === 'payment' ? {...entry, refundable_minor: 18000} : entry)})).toThrow();
  });
  it('matches the returned ledger entry to the complete order and operation UUID', () => {
    expect(() => checkedLedgerResult({...deposit, entry: {...deposit.entry, id: 'not-in-order'}})).toThrow();
    expect(() => checkedLedgerResult({...deposit, order: {...deposit.order, ledger: []}})).toThrow();
    const operation = {operation_id: 'wrong-op', state: 'succeeded', resource_type: 'order', resource_id: deposit.order.id, result: {http_status: 201, body: deposit}, error: null, started_at: deposit.entry.recorded_at, completed_at: deposit.entry.recorded_at};
    expect(() => checkedOrderOperation(operation, 'wrong-op')).toThrow();
  });
});
