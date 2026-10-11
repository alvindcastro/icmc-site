import * as Dialog from '@radix-ui/react-dialog';
import {useEffect, useRef, useState} from 'react';
import {Check, RotateCw, X} from 'lucide-react';
import {ApiError, type ApiClient} from '../api/client';
import {holdAttempt, releaseAttempt} from '../api/pending';
import type {BusinessSettings} from '../api/types';
import {Feedback, Field, IconButton} from '../components/ui';
import {formatCalendarDate, formatMoney, paymentMethodLabel} from '../lib/format';
import {parsePrice} from '../menu/model';
import {orderOperationMarker} from './OrderEditor';
import {NavigationGuard} from './NavigationGuard';
import {readOrderOperation} from './operations';
import {checkedDashboard, checkedLedgerResult, checkedOrder, operationOrder} from './responses';
import {Amounts, OrderReview} from './presentation';
import type {Order, OrderAction} from './types';

export type ActionKind = 'preparing' | 'ready' | 'completed' | 'cancel' | 'payment' | 'refund';
export const actionPermission: Record<ActionKind, OrderAction> = {preparing: 'start_preparing', ready: 'mark_ready', completed: 'complete', cancel: 'cancel', payment: 'record_payment', refund: 'refund'};
const titles: Record<ActionKind, string> = {preparing: 'Start preparing', ready: 'Mark ready', completed: 'Complete order', cancel: 'Cancel order', payment: 'Record payment', refund: 'Record refund'};
const confirms: Record<ActionKind, string> = {preparing: 'Confirm preparing', ready: 'Confirm ready', completed: 'Confirm completion', cancel: 'Confirm cancellation', payment: 'Confirm payment', refund: 'Confirm refund'};
const messages: Record<ActionKind, string> = {preparing: 'Status updated.', ready: 'Status updated.', completed: 'Status updated.', cancel: 'Order cancelled.', payment: 'Payment recorded.', refund: 'Refund recorded.'};
type Entry = {amount: string; date: string; method: string; reference: string; note: string; reason: string; payment: string};
type Attempt = {id: string; path: string; body: Record<string, unknown>};

export function ActionDialog({client, settings, order, action, onClose, onSaved}: {
  client: ApiClient; settings: BusinessSettings; order: Order; action: ActionKind; onClose: (refresh?: boolean) => void; onSaved: (order: Order, message?: string) => void;
}) {
  const financial = action === 'payment' || action === 'refund';
  const label = action === 'refund' ? 'Refund' : 'Payment';
  const initial = useRef<Entry>({amount: '', date: '', method: settings.payment_methods[0] ?? '', reference: '', note: '', reason: '', payment: order.ledger.find(item => item.type === 'payment' && item.refundable_minor! > 0)?.id ?? ''});
  const opener = useRef(document.activeElement as HTMLElement | null);
  const [entry, setEntry] = useState(initial.current); const [base, setBase] = useState(order);
  const [fields, setFields] = useState<Record<string, string>>({}); const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState(false); const [attested, setAttested] = useState(false); const [stock, setStock] = useState(false);
  const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false); const [retryAllowed, setRetryAllowed] = useState(false);
  const [conflict, setConflict] = useState<Order | null>(null); const [discard, setDiscard] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [dateError, setDateError] = useState<string | null>(null); const [dateRetry, setDateRetry] = useState(0);
  const [reviewBody, setReviewBody] = useState<Record<string, unknown> | null>(null);
  const active = useRef(true); const saving = useRef(false); const attempt = useRef<Attempt | null>(null);
  const controller = useRef(new AbortController()); const form = useRef<HTMLFormElement>(null); const content = useRef<HTMLDivElement>(null);
  const dirty = JSON.stringify(entry) !== JSON.stringify(initial.current) || attested || stock;
  // Readiness is attested by staff only while preparation is not recorded; recorded orders rely on prepared quantities.
  const fulfilling = action === 'ready' || action === 'completed', attests = fulfilling && base.preparation_tracking === 'manual';
  const permission = base.permitted_actions[actionPermission[action]];
  const frozen = busy || uncertain || Boolean(conflict) || needsReload || !permission.allowed;
  const original = base.ledger.find(item => item.type === 'payment' && item.id === entry.payment);
  const maximum = action === 'refund' ? Math.min(original?.refundable_minor ?? 0, base.net_paid_minor) : base.balance_due_minor;
  useEffect(() => () => {active.current = false; controller.current.abort();}, []);
  useEffect(() => {
    if (!financial) return;
    let live = true; const abort = new AbortController(); setDateError(null);
    void client.request('/dashboard', {signal: abort.signal}).then(value => {
      const day = checkedDashboard(value).business_date;
      if (live) {initial.current = {...initial.current, date: day}; setEntry(current => current.date ? current : {...current, date: day});}
    }).catch(failure => {if (live) setDateError(`Business date unavailable: ${failure.message}`);});
    return () => {live = false; abort.abort();};
  }, [client, financial, dateRetry]);
  useEffect(() => {if (review || conflict) {if (content.current) content.current.scrollTop = 0;}}, [review, conflict]);
  useEffect(() => {if (!busy && !review && !discard) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();}, [fields, busy, review, discard]);
  useEffect(() => {
    if (!dirty && !busy && !uncertain) return;
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';};
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy, uncertain]);
  function change(next: Partial<Entry>) {if (frozen) return; setEntry(current => ({...current, ...next})); setFields({}); setError(null); setReview(false); setReviewBody(null);}
  function build() {
    const errors: Record<string, string> = {}; const body: Record<string, unknown> = {expected_version: base.version};
    if (financial) {
      const amount = parsePrice(entry.amount, settings.minor_digits);
      if (amount === null || amount <= 0) errors['/amount_minor'] = `Enter a positive amount with up to ${settings.minor_digits} decimal places.`;
      else if (amount > maximum) errors['/amount_minor'] = `Amount must not exceed ${formatMoney(maximum, base)}.`;
      try {formatCalendarDate(entry.date);} catch {errors[action === 'refund' ? '/refunded_on' : '/paid_on'] = 'Enter a valid transaction date.';}
      if (!settings.payment_methods.includes(entry.method as BusinessSettings['payment_methods'][number])) errors['/method'] = 'Select an enabled payment method.';
      if (entry.reference.length > 200) errors['/reference'] = 'Reference must not exceed 200 characters.';
      if (entry.note.length > 2000) errors['/note'] = 'Note must not exceed 2000 characters.';
      Object.assign(body, {amount_minor: amount, [action === 'refund' ? 'refunded_on' : 'paid_on']: entry.date, method: entry.method, reference: entry.reference, note: entry.note});
      if (action === 'refund') {if (!original || maximum <= 0) errors['/payment_id'] = 'Select a refundable payment.'; body.payment_id = entry.payment;}
    } else if (action !== 'cancel') body.to_status = action;
    if (action === 'refund' || action === 'cancel') {
      if (!entry.reason.trim() || entry.reason.trim().length > 1000) errors['/reason'] = 'Enter a reason of up to 1000 characters.';
      body.reason = entry.reason.trim();
    }
    if (action === 'cancel') {
      body.acknowledge_consumed_stock = stock;
      if (base.cancellation_requires_stock_acknowledgment && !stock) errors['/acknowledge_consumed_stock'] = 'Acknowledge the consumed stock before cancelling.';
    }
    return {body, errors};
  }
  function reviewTransaction() {
    if (frozen) return;
    const {body, errors} = build(); setFields(errors); setError(null);
    if (!Object.keys(errors).length) {setReviewBody(body); setReview(true);}
  }
  function failure(value: unknown, mutation = false) {
    const cause = value instanceof ApiError ? value : new ApiError(0, 'invalid_response', value instanceof Error ? value.message : 'The response could not be verified.', [], mutation);
    if (mutation && (cause.uncertain || ['operation_in_progress', 'operation_payload_mismatch'].includes(cause.code))) {
      setUncertain(true); setError('Transaction result unconfirmed. Check its status before another submission.'); return;
    }
    if (mutation) {releaseAttempt(orderOperationMarker); attempt.current = null; setUncertain(false); setRetryAllowed(false);}
    setReview(false); setReviewBody(null); setError(cause.message); setFields(Object.fromEntries(cause.fieldErrors.map(item => [item.path, item.message])));
    if (cause.code === 'version_conflict') {
      try {const latest = checkedOrder(cause.details.latest_resource); if (latest.id !== base.id) throw new Error(); setConflict(latest);}
      catch {setNeedsReload(true); setError('The latest order could not be verified. Keep your draft and reload before submitting.');}
    }
  }
  function matched(value: unknown, pending: Attempt) {
    const saved = operationOrder(value);
    if (saved.id !== base.id || saved.version !== Number(pending.body.expected_version) + 1) throw new Error('The saved order identity or version could not be verified.');
    if (financial) {
      const result = checkedLedgerResult(value); const item = result.entry; const body = pending.body;
      if (item.operation_id !== pending.id || item.type !== action || item.amount_minor !== body.amount_minor || item.business_date !== (body.paid_on ?? body.refunded_on)
        || item.method !== body.method || item.reference !== body.reference || item.note !== body.note || (action === 'refund' && (item.payment_id !== body.payment_id || item.reason !== body.reason))) throw new Error('The ledger entry could not be matched to this transaction.');
    } else if (saved.status !== (action === 'cancel' ? 'cancelled' : action)) throw new Error('The saved status could not be matched to this action.');
    return saved;
  }
  async function send(pending: Attempt) {
    if (saving.current) return; saving.current = true; setBusy(true); setError(null); setRetryAllowed(false); attempt.current = pending;
    holdAttempt(orderOperationMarker, {...pending, method: 'POST'});
    try {
      const raw = await client.request(pending.path, {method: 'POST', body: pending.body, operationId: pending.id});
      const saved = matched(raw, pending);
      if (!active.current) return;
      releaseAttempt(orderOperationMarker); onSaved(saved, messages[action]);
    } catch (cause) {if (active.current) failure(cause, true);}
    finally {saving.current = false; if (active.current) setBusy(false);}
  }
  function confirm() {
    if (frozen || saving.current || (attests && !attested)) return;
    const built = build(); setFields(built.errors);
    if (Object.keys(built.errors).length || (financial && (!review || !reviewBody))) return;
    void send({id: crypto.randomUUID(), path: `/orders/${encodeURIComponent(base.id)}/${financial ? action === 'payment' ? 'payments' : 'refunds' : action === 'cancel' ? 'cancel' : 'transitions'}`, body: financial ? reviewBody! : built.body});
  }
  async function reconcile() {
    const pending = attempt.current; if (!pending || saving.current) return;
    saving.current = true; setBusy(true); setRetryAllowed(false);
    try {
      const operation = await readOrderOperation(client, pending.id, controller.current.signal);
      if (!active.current) return;
      if (operation.state === 'succeeded') {const saved = matched(operation.result!.body, pending); releaseAttempt(orderOperationMarker); onSaved(saved, messages[action]);}
      else if (operation.state === 'rejected') {const rejected = operation.error!; failure(new ApiError(rejected.http_status, rejected.error.code, rejected.error.message, rejected.error.field_errors, false, rejected.error.details), true);}
      else setError('Transaction is still processing. Check again before another submission.');
    } catch (cause) {
      if (active.current) {if (cause instanceof ApiError && cause.status === 404) {setRetryAllowed(true); setError('No transaction was recorded. You may retry the identical request with its original operation ID.');} else setError('Transaction status could not be verified. Check again.');}
    } finally {saving.current = false; if (active.current) setBusy(false);}
  }
  function leave() {onClose(Boolean(conflict) || needsReload || base.version !== order.version);}
  function close() {if (saving.current) return; if (dirty || uncertain) setDiscard(true); else leave();}
  function textArea(name: string, key: 'reason' | 'note', maximum: number) {
    const path = `/${key}`; return <div className="field"><label htmlFor={`transaction-${key}`}>{name}</label><textarea id={`transaction-${key}`} maxLength={maximum} value={entry[key]} disabled={frozen} onChange={event => change({[key]: event.target.value})} aria-invalid={Boolean(fields[path])} aria-describedby={fields[path] ? `transaction-${key}-error` : undefined} />{fields[path] && <p id={`transaction-${key}-error`} className="field-error">{fields[path]}</p>}</div>;
  }
  return <Dialog.Root open onOpenChange={open => {if (!open) close();}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content ref={content} className="editor-dialog order-editor transaction-dialog" aria-describedby={undefined}
    onOpenAutoFocus={event => {event.preventDefault(); if (financial) document.getElementById('transaction-amount')?.focus(); else if (action === 'cancel') document.getElementById('transaction-reason')?.focus(); else if (action === 'preparing') document.getElementById('transaction-confirm')?.focus(); else (form.current?.querySelector<HTMLElement>('input') ?? document.getElementById('transaction-confirm'))?.focus();}}
    onCloseAutoFocus={event => {event.preventDefault(); if (opener.current?.isConnected) opener.current.focus(); else document.getElementById('main-content')?.focus();}}
    onEscapeKeyDown={event => {event.preventDefault(); close();}} onPointerDownOutside={event => event.preventDefault()}>
    <div className="editor-heading"><div><Dialog.Title>{discard ? 'Discard changes?' : titles[action]}</Dialog.Title><small>{base.reference} / Version {base.version}</small></div><IconButton label="Close transaction" disabled={busy} onClick={close}><X size={20} /></IconButton></div>
    {discard ? <><p className="discard-copy">{uncertain ? 'This transaction is still unresolved. Closing discards these entries; check or retry it from the page.' : 'This transaction has unsaved changes.'}</p><div className="editor-actions"><button className="button secondary" onClick={() => setDiscard(false)}>Keep editing</button><button className="button danger" onClick={leave}>Discard changes</button></div></> : <>
      {error && <Feedback error>{error}</Feedback>}
      {uncertain && <div className="editor-actions"><button className="button secondary" disabled={busy} onClick={() => void reconcile()}><RotateCw size={17} />Check transaction status</button>{retryAllowed && <button className="button secondary" disabled={busy} onClick={() => attempt.current && void send(attempt.current)}><RotateCw size={17} />Retry identical transaction</button>}</div>}
      {conflict && <section className="conflict-review"><h3>Latest saved order</h3><OrderReview value={conflict} customer={conflict.customer} notes={conflict.notes} /><div className="editor-actions"><button className="button secondary" onClick={() => {setBase(conflict); setConflict(null); setError(null); setFields({}); setReview(false); setReviewBody(null); setAttested(false); setStock(false);}}>Use reviewed order version</button></div></section>}
      {!permission.allowed && <Feedback>{permission.reason}</Feedback>}
      {financial ? review && reviewBody ? <section aria-label={`${label} review`} className="transaction-review"><h3>{label} review</h3><dl className="order-facts"><div><dt>Amount</dt><dd>{formatMoney(reviewBody.amount_minor as number, base)}</dd></div><div><dt>Date</dt><dd>{formatCalendarDate(entry.date)}</dd></div><div><dt>Method</dt><dd>{paymentMethodLabel(entry.method)}</dd></div>{action === 'refund' && <><div><dt>Original payment</dt><dd>{original?.reference || original?.id}</dd></div><div><dt>Reason</dt><dd>{entry.reason}</dd></div></>}<div><dt>Reference</dt><dd>{entry.reference || 'Not provided'}</dd></div><div><dt>Note</dt><dd>{entry.note || 'Not provided'}</dd></div></dl><Amounts value={base} /></section> : <form ref={form} className="editor-fields" onSubmit={event => {event.preventDefault(); reviewTransaction();}} noValidate>
        {dateError && <Feedback error>{dateError}<button type="button" className="text-action" disabled={busy || uncertain} onClick={() => setDateRetry(value => value + 1)}>Retry business date</button></Feedback>}
        {action === 'refund' && <div className="field"><label htmlFor="transaction-payment">Original payment</label><select id="transaction-payment" value={entry.payment} disabled={frozen} onChange={event => change({payment: event.target.value})} aria-invalid={Boolean(fields['/payment_id'])} aria-describedby={fields['/payment_id'] ? 'transaction-payment-error' : undefined}>{base.ledger.filter(item => item.type === 'payment' && item.refundable_minor! > 0).map(item => <option key={item.id} value={item.id}>{formatCalendarDate(item.business_date)} / {item.reference || item.id} / {formatMoney(item.refundable_minor!, base)} refundable</option>)}</select>{fields['/payment_id'] && <p id="transaction-payment-error" className="field-error">{fields['/payment_id']}</p>}</div>}
        <div className="entry-grid"><Field id="transaction-amount" label={`${label} amount`} inputMode="decimal" value={entry.amount} disabled={frozen} onChange={event => change({amount: event.target.value})} error={fields['/amount_minor']} /><Field id="transaction-date" label={`${label} date`} type="date" value={entry.date} disabled={frozen} onChange={event => change({date: event.target.value})} error={fields[action === 'refund' ? '/refunded_on' : '/paid_on']} /></div>
        <small>Maximum {formatMoney(maximum, base)}</small><div className="field"><label htmlFor="transaction-method">{label} method</label><select id="transaction-method" disabled={frozen} value={entry.method} onChange={event => change({method: event.target.value})} aria-invalid={Boolean(fields['/method'])} aria-describedby={fields['/method'] ? 'transaction-method-error' : undefined}>{settings.payment_methods.map(method => <option key={method} value={method}>{paymentMethodLabel(method)}</option>)}</select>{fields['/method'] && <p id="transaction-method-error" className="field-error">{fields['/method']}</p>}</div>
        <Field id="transaction-reference" label={`${label} reference`} maxLength={200} value={entry.reference} disabled={frozen} onChange={event => change({reference: event.target.value})} error={fields['/reference']} />
        {action === 'refund' && textArea('Refund reason', 'reason', 1000)}{textArea(`${label} note`, 'note', 2000)}
        <div className="editor-actions"><button className="button primary" type="submit" disabled={frozen}><Check size={17} />Review {action}</button></div>
      </form> : <><OrderReview value={base} customer={base.customer} notes={base.notes} />
        <form ref={form} onSubmit={event => {event.preventDefault(); confirm();}} noValidate className="entry-section">
          {action === 'cancel' && <>{textArea('Cancellation reason', 'reason', 1000)}<p>Payment history is retained. Any funds held become customer credit until separately refunded.</p>{base.items.some(item => (item.prepared_quantity ?? 0) > 0) && <ul className="prepared-review">{base.items.filter(item => (item.prepared_quantity ?? 0) > 0).map(item => <li key={item.id}>{`${item.prepared_quantity} of ${item.quantity} ${item.variant_label} of ${item.food_name} already prepared`}</li>)}</ul>}{base.cancellation_requires_stock_acknowledgment && <><label className="checkbox-field"><input type="checkbox" checked={stock} disabled={frozen} onChange={event => {setStock(event.target.checked); setFields({});}} aria-invalid={Boolean(fields['/acknowledge_consumed_stock'])} aria-describedby={fields['/acknowledge_consumed_stock'] ? 'transaction-stock-error' : undefined} />Consumed ingredients will not be restored; stock corrections are separate.</label>{fields['/acknowledge_consumed_stock'] && <p id="transaction-stock-error" className="field-error">{fields['/acknowledge_consumed_stock']}</p>}</>}</>}
          {fulfilling && !attests && <p>All ordered quantities are recorded as prepared.</p>}
          {attests && <label className="checkbox-field"><input type="checkbox" checked={attested} disabled={frozen} onChange={event => setAttested(event.target.checked)} />{action === 'ready' ? 'Food is ready for pickup or delivery' : 'Order has been fulfilled'}</label>}
        </form></>}
      {(!financial || review) && <div className="editor-actions">{financial && <button className="button secondary" disabled={frozen} onClick={() => {setReview(false); setReviewBody(null);}}>Back to edit</button>}<button id="transaction-confirm" className={`button ${action === 'cancel' ? 'danger' : 'primary'}`} disabled={frozen || (attests && !attested)} onClick={confirm}><Check size={17} />{busy ? 'Saving...' : confirms[action]}</button></div>}
    </>}
    <NavigationGuard dirty={dirty || uncertain} busy={busy} onLeave={leave} />
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
