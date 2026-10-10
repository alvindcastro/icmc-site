import type {Dashboard, Fulfillment, LedgerEntry, LedgerResult, Order, OrderMutationResult, OrderSummary, Quote, SnapshotLine, Totals} from './types';
import type {Operation} from '../api/types';
import {checkedPage} from '../menu/responses';
import {formatCalendarDate} from '../lib/format';
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const money = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const instant = (value: unknown) => text(value) && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const status = (value: unknown) => ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'].includes(String(value));
const payment = (value: unknown) => ['unpaid', 'partial', 'paid', 'credit_due'].includes(String(value));
function fail(): never {throw new Error('The server returned an invalid order response.');}
function date(value: unknown) {try {if (!text(value)) return false; formatCalendarDate(value); return true;} catch {return false;}}
function timezone(value: unknown) {try {if (!text(value)) return false; new Intl.DateTimeFormat('en', {timeZone: value}); return true;} catch {return false;}}
function currency(value: {currency: string; minor_digits: number}) {
  if (!/^[A-Z]{3}$/.test(value.currency) || !Number.isInteger(value.minor_digits) || value.minor_digits < 0 || value.minor_digits > 9) fail();
}
function totals(value: Totals) {
  currency(value);
  for (const key of ['subtotal_minor', 'delivery_charge_minor', 'tax_minor', 'total_minor', 'settlement_total_minor', 'net_paid_minor', 'balance_due_minor', 'customer_credit_minor'] as const) if (!money(value[key])) fail();
}
function fulfillment(value: Fulfillment) {
  if (!value || !['pickup', 'delivery'].includes(value.method) || !date(value.local_date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.local_time)
    || !timezone(value.timezone) || !instant(value.fulfillment_at) || !text(value.utc_offset) || !/^[+-]\d{2}:\d{2}$/.test(value.utc_offset)
    || (value.method === 'delivery' ? !text(value.address) : value.address !== null) || (value.pickup_location !== null && !text(value.pickup_location))) fail();
}
function line(value: SnapshotLine) {
  if (!value || !text(value.variant_id) || !text(value.food_name) || !text(value.variant_label) || !positive(value.quantity)
    || !money(value.unit_price_minor) || !money(value.line_total_minor) || typeof value.preparation_notes !== 'string'
    || !['tray', 'piece', 'stick', 'package'].includes(value.selling_unit)
    || (value.selling_unit === 'package' ? !positive(value.package_contents?.quantity) || value.package_contents?.unit !== 'piece' : value.package_contents !== null)
    || (value.prepared_quantity !== null && !money(value.prepared_quantity)) || (value.remaining_quantity !== null && !money(value.remaining_quantity))) fail();
}
export function checkedOrder(value: unknown): Order {
  const order = value as Order;
  if (!order || !text(order.id) || !text(order.reference) || !positive(order.version) || !status(order.status) || !payment(order.payment_status)
    || !order.customer || !text(order.customer.name) || !text(order.customer.phone) || typeof order.customer.notes !== 'string' || typeof order.notes !== 'string'
    || !Array.isArray(order.items) || !order.items.length || new Set(order.items.map(item => item?.id)).size !== order.items.length
    || !['manual', 'recorded'].includes(order.preparation_tracking) || !money(order.payments_minor) || !money(order.refunds_minor) || !Array.isArray(order.ledger)
    || !instant(order.created_at) || !instant(order.updated_at) || !Array.isArray(order.status_history) || !order.status_history.length || typeof order.cancellation_requires_stock_acknowledgment !== 'boolean') fail();
  totals(order); fulfillment(order.fulfillment);
  order.ledger.forEach(checkedLedgerEntry);
  if (new Set(order.ledger.map(entry => entry.id)).size !== order.ledger.length || new Set(order.ledger.map(entry => entry.operation_id)).size !== order.ledger.length) fail();
  const payments = order.ledger.filter(entry => entry.type === 'payment'), refunds = order.ledger.filter(entry => entry.type === 'refund');
  if (refunds.some(entry => !payments.some(payment => payment.id === entry.payment_id))) fail();
  payments.forEach(entry => {
    const returned = refunds.filter(refund => refund.payment_id === entry.id).reduce((sum, refund) => sum + BigInt(refund.amount_minor), 0n);
    if (returned > BigInt(entry.amount_minor) || BigInt(entry.refundable_minor!) !== BigInt(entry.amount_minor) - returned) fail();
  });
  const paid = payments.reduce((sum, entry) => sum + BigInt(entry.amount_minor), 0n), returned = refunds.reduce((sum, entry) => sum + BigInt(entry.amount_minor), 0n);
  if (paid !== BigInt(order.payments_minor) || returned !== BigInt(order.refunds_minor) || paid - returned !== BigInt(order.net_paid_minor)
    || order.settlement_total_minor !== (order.status === 'cancelled' ? 0 : order.total_minor)
    || order.balance_due_minor !== Math.max(0, order.settlement_total_minor - order.net_paid_minor) || order.customer_credit_minor !== Math.max(0, order.net_paid_minor - order.settlement_total_minor)
    || order.payment_status !== (order.customer_credit_minor > 0 ? 'credit_due' : order.balance_due_minor > 0 ? order.net_paid_minor > 0 ? 'partial' : 'unpaid' : 'paid')) fail();
  order.items.forEach(item => {line(item); if (!text(item.id)) fail();});
  for (const key of ['edit', 'confirm', 'start_preparing', 'mark_ready', 'complete', 'cancel', 'record_payment', 'refund', 'record_preparation'] as const) {
    const action = order.permitted_actions?.[key];
    if (!action || typeof action.allowed !== 'boolean' || (!action.allowed && (!text(action.reason) || !text(action.reason_code)))) fail();
  }
  order.status_history.forEach(event => {
    if (!text(event.id) || !status(event.to_status) || (event.from_status !== null && !status(event.from_status)) || !instant(event.changed_at)
      || !text(event.actor?.id) || !text(event.actor?.display_name) || (event.to_status === 'cancelled' && !text(event.reason))) fail();
  });
  return order;
}
export function checkedQuote(value: unknown): Quote {
  const quote = value as Quote;
  if (!quote || !text(quote.id) || !instant(quote.expires_at) || !positive(quote.settings_version) || typeof quote.credit_acknowledgment_required !== 'boolean'
    || (quote.order_id === null ? quote.expected_version !== null : !text(quote.order_id) || !positive(quote.expected_version))
    || !Array.isArray(quote.lines) || !quote.lines.length || new Set(quote.lines.map(item => item?.client_line_id)).size !== quote.lines.length) fail();
  totals(quote); fulfillment(quote.fulfillment);
  quote.lines.forEach(item => {line(item); if (!text(item.client_line_id) || (item.order_item_id !== null && !text(item.order_item_id))) fail();});
  return quote;
}
export function checkedSummary(value: unknown): OrderSummary {
  const summary = value as OrderSummary;
  if (!summary || !text(summary.id) || !text(summary.reference) || !positive(summary.version) || !text(summary.customer_name) || !text(summary.customer_phone)
    || !instant(summary.fulfillment_at) || !date(summary.fulfillment_local_date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(summary.fulfillment_local_time)
    || !timezone(summary.fulfillment_timezone) || !['pickup', 'delivery'].includes(summary.fulfillment_method) || !status(summary.status) || !payment(summary.payment_status)
    || !money(summary.total_minor) || !money(summary.balance_due_minor) || !money(summary.customer_credit_minor)) fail();
  currency(summary); return summary;
}
export function checkedDashboard(value: unknown): Dashboard {
  const dashboard = value as Dashboard;
  if (!dashboard || !date(dashboard.business_date) || !timezone(dashboard.timezone)) fail();
  checkedPage(dashboard.today, checkedSummary); checkedPage(dashboard.upcoming, checkedSummary); return dashboard;
}
export function checkedOrderOperation(value: unknown, id: string): Operation<OrderMutationResult> {
  const operation = value as Operation<OrderMutationResult>;
  if (!operation || operation.operation_id !== id || !['processing', 'succeeded', 'rejected'].includes(operation.state) || !instant(operation.started_at)) fail();
  if (operation.state === 'succeeded') {
    if (operation.resource_type !== 'order' || !operation.result || ![200, 201].includes(operation.result.http_status) || !instant(operation.completed_at)
      || operationOrder(operation.result.body).id !== operation.resource_id) fail();
    if ('entry' in operation.result.body && operation.result.body.entry.operation_id !== id) fail();
  }
  if (operation.state === 'rejected') {
    const error = operation.error;
    if (!error || !Number.isInteger(error.http_status) || error.http_status < 400 || error.http_status >= 500 || !text(error.error?.code) || !text(error.error?.message)
      || !Array.isArray(error.error.field_errors) || error.error.field_errors.some(field => !text(field.path) || !text(field.code) || !text(field.message))
      || !error.error.details || typeof error.error.details !== 'object' || !instant(operation.completed_at)) fail();
  }
  return operation;
}
export function checkedLedgerEntry(value: unknown): LedgerEntry {
  const entry = value as LedgerEntry;
  if (!entry || !text(entry.id) || !['payment', 'refund'].includes(entry.type) || !positive(entry.amount_minor) || !date(entry.business_date)
    || !['cash', 'bank_transfer', 'other'].includes(entry.method) || typeof entry.reference !== 'string' || typeof entry.note !== 'string'
    || !text(entry.operation_id) || !instant(entry.recorded_at) || !text(entry.recorded_by?.id) || !text(entry.recorded_by?.display_name)
    || (entry.type === 'refund' ? !text(entry.payment_id) || !text(entry.reason) || entry.refundable_minor !== null
      : entry.payment_id !== null || entry.reason !== null || !money(entry.refundable_minor) || entry.refundable_minor! > entry.amount_minor)) fail();
  return entry;
}
export function checkedLedgerResult(value: unknown): LedgerResult {
  const result = value as LedgerResult;
  if (!result) fail(); checkedLedgerEntry(result.entry); checkedOrder(result.order);
  const saved = result.order.ledger.find(entry => entry.id === result.entry.id);
  if (!saved || (Object.keys(result.entry) as (keyof LedgerEntry)[]).some(key => key !== 'recorded_by' && saved[key] !== result.entry[key])
    || saved.recorded_by.id !== result.entry.recorded_by.id || saved.recorded_by.display_name !== result.entry.recorded_by.display_name) fail();
  return result;
}
export function operationOrder(value: unknown): Order {
  return value && typeof value === 'object' && 'entry' in value ? checkedLedgerResult(value).order : checkedOrder(value);
}
