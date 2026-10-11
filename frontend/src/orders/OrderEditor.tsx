import * as Dialog from '@radix-ui/react-dialog';
import {useEffect, useRef, useState} from 'react';
import {Check, Plus, RotateCw, Save, Search, Trash2, X} from 'lucide-react';
import {ApiError, type ApiClient} from '../api/client';
import {holdAttempt, releaseAttempt} from '../api/pending';
import type {BusinessSettings, Food, MenuVariant} from '../api/types';
import {Feedback, Field, IconButton, Loading} from '../components/ui';
import {formatCalendarDate, formatMoney} from '../lib/format';
import {parsePrice, priceInput, sellingLabel} from '../menu/model';
import {checkedFood, checkedPage} from '../menu/responses';
import {checkedOrder, checkedQuote, operationOrder} from './responses';
import {readOrderOperation} from './operations';
import type {Order, OrderDraft, OrderLine, Quote} from './types';
import {Amounts, OrderReview} from './presentation';
import {NavigationGuard} from './NavigationGuard';

export const orderOperationMarker = 'food-reservations:order-operation';
type Entry = {name: string; phone: string; customer_notes: string; method: 'pickup' | 'delivery'; date: string; time: string; offset: string;
  address: string; notes: string; delivery: string; tax: string; items: {id: string; saved?: OrderLine; variant: MenuVariant | null; food_name: string; quantity: string; notes: string}[]};
type Attempt = {id: string; path: string; method: string; body: unknown};
const deliveryDisabled = 'Delivery is no longer enabled. Choose another fulfillment method.';
const offeredMethods = (settings: BusinessSettings) => settings.fulfillment_methods.filter(method => method !== 'delivery' || settings.delivery_policy.mode !== 'disabled');
function entryFor(order: Order | undefined, settings: BusinessSettings): Entry {
  return {name: order?.customer.name ?? '', phone: order?.customer.phone ?? '', customer_notes: order?.customer.notes ?? '', method: order?.fulfillment.method ?? offeredMethods(settings)[0] ?? settings.fulfillment_methods[0],
    date: order?.fulfillment.local_date ?? '', time: order?.fulfillment.local_time ?? '', offset: order?.fulfillment.utc_offset ?? '', address: order?.fulfillment.address ?? '', notes: order?.notes ?? '',
    delivery: priceInput(order?.delivery_charge_minor ?? 0, settings.minor_digits), tax: priceInput(order?.tax_minor ?? 0, settings.minor_digits),
    items: order?.items.map(item => ({id: item.id, saved: item, variant: null, food_name: item.food_name, quantity: String(item.quantity), notes: item.preparation_notes})) ?? []};
}
function build(entry: Entry, settings: BusinessSettings) {
  const errors: Record<string, string> = {};
  if (!entry.name.trim()) errors['/draft/customer/name'] = 'Enter a customer name.';
  if (!entry.phone.trim()) errors['/draft/customer/phone'] = 'Enter a contact phone.';
  try {formatCalendarDate(entry.date);} catch {errors['/draft/fulfillment/local_date'] = 'Enter a valid fulfillment date.';}
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(entry.time)) errors['/draft/fulfillment/local_time'] = 'Enter a valid fulfillment time.';
  if (entry.method === 'delivery' && settings.delivery_policy.mode === 'disabled') errors['/draft/fulfillment/method'] = deliveryDisabled;
  if (entry.method === 'delivery' && !entry.address.trim()) errors['/draft/fulfillment/address'] = 'Enter a delivery address.';
  if (!entry.items.length) errors['/draft/items'] = 'Add at least one item.';
  entry.items.forEach((item, i) => {if (!/^\d+$/.test(item.quantity) || !Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) < 1) errors[`/draft/items/${i}/quantity`] = 'Enter a positive whole quantity.';});
  const delivery = entry.method === 'pickup' ? 0 : settings.delivery_policy.mode === 'fixed_amount' ? settings.delivery_policy.fixed_charge_minor : parsePrice(entry.delivery, settings.minor_digits);
  const tax = parsePrice(entry.tax, settings.minor_digits);
  if (delivery === null) errors['/draft/delivery_charge_minor'] = `Enter a nonnegative amount with up to ${settings.minor_digits} decimal places.`;
  if (tax === null) errors['/draft/tax_minor'] = `Enter a nonnegative amount with up to ${settings.minor_digits} decimal places.`;
  const draft: OrderDraft = {customer: {name: entry.name.trim(), phone: entry.phone.trim(), notes: entry.customer_notes},
    fulfillment: {method: entry.method, local_date: entry.date, local_time: entry.time, timezone: settings.timezone, utc_offset: entry.offset || null, address: entry.method === 'delivery' ? entry.address.trim() : null},
    items: entry.items.map(item => ({client_line_id: item.id, ...(item.saved ? {order_item_id: item.saved.id} : {}), variant_id: item.saved?.variant_id ?? item.variant!.id,
      quantity: Number(item.quantity), preparation_notes: item.notes})), notes: entry.notes, delivery_charge_minor: delivery ?? 0, tax_minor: tax ?? 0};
  return {errors, draft};
}

export function OrderEditor({client, settings, order, confirmOnly, onClose, onSaved}: {
  client: ApiClient; settings: BusinessSettings; order?: Order; confirmOnly: boolean; onClose: () => void; onSaved: (order: Order) => void;
}) {
  const initial = useRef(entryFor(order, settings));
  const opener = useRef(document.activeElement as HTMLElement | null);
  const [entry, setEntry] = useState(initial.current); const [base, setBase] = useState(order);
  const [foods, setFoods] = useState<Food[]>([]); const [menuError, setMenuError] = useState<string | null>(null); const [menuLoading, setMenuLoading] = useState(!confirmOnly); const [menuRetry, setMenuRetry] = useState(0);
  const [search, setSearch] = useState(''); const [selected, setSelected] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null); const quoteDraft = useRef<OrderDraft | null>(null);
  const [review, setReview] = useState(confirmOnly); const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null); const [quoting, setQuoting] = useState(false); const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Order | null>(null); const [offsets, setOffsets] = useState<string[]>([]); const [discard, setDiscard] = useState(false);
  const [uncertain, setUncertain] = useState(false); const [retryAllowed, setRetryAllowed] = useState(false); const [credit, setCredit] = useState(false);
  const attempt = useRef<Attempt | null>(null); const saving = useRef(false); const sequence = useRef(0); const active = useRef(true); const form = useRef<HTMLFormElement>(null);
  const dirty = JSON.stringify(entry) !== JSON.stringify(initial.current);
  const blocked = uncertain || busy || Boolean(conflict) || base?.permitted_actions[confirmOnly ? 'confirm' : 'edit'].allowed === false;
  const content = useRef<HTMLDivElement>(null); const controller = useRef(new AbortController());
  useEffect(() => () => {active.current = false; sequence.current++; controller.current.abort();}, []);
  useEffect(() => {if (review || conflict) {if (content.current) content.current.scrollTop = 0;}}, [review, conflict]);
  useEffect(() => {
    if (!dirty && !busy && !uncertain) return;
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';};
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy, uncertain]);
  useEffect(() => {if (!busy && !quoting && !review && !discard && Object.keys(fields).length) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();}, [fields, busy, quoting, review, discard]);
  useEffect(() => {
    if (confirmOnly) return;
    let live = true; const controller = new AbortController(); setMenuLoading(true); setMenuError(null);
    void (async () => {
      const result: Food[] = []; let page = 1; let more = true;
      while (more) {const data = checkedPage(await client.request(`/foods?available=true&limit=100&page=${page++}`, {signal: controller.signal}), checkedFood); result.push(...data.items); more = data.has_next;}
      if (live) setFoods(result);
    })().catch(failure => {if (live) setMenuError(failure.message);}).finally(() => {if (live) setMenuLoading(false);});
    return () => {live = false; controller.abort();};
  }, [client, confirmOnly, menuRetry]);
  useEffect(() => {
    if (!quote) return;
    const timer = window.setTimeout(() => {setQuote(null); quoteDraft.current = null; setReview(false); setError('Quote expired. Review the order again.');}, Math.max(0, Date.parse(quote.expires_at) - client.now()));
    return () => window.clearTimeout(timer);
  }, [client, quote]);
  function change(next: Partial<Entry>) {if (busy || uncertain) return; sequence.current++; setQuoting(false); setEntry(value => ({...value, ...next})); setQuote(null); quoteDraft.current = null; setReview(false); setFields({}); setError(null); setCredit(false);}
  function failure(value: unknown, mutation = false) {
    const cause = value instanceof ApiError ? value : new ApiError(0, 'invalid_response', value instanceof Error ? value.message : 'The response could not be verified.', [], mutation);
    if (mutation && (cause.uncertain || ['operation_in_progress', 'operation_payload_mismatch'].includes(cause.code))) {setUncertain(true); setError('Save result unconfirmed. Check its status before another submission.'); return;}
    if (mutation) {releaseAttempt(orderOperationMarker); attempt.current = null; setUncertain(false); setRetryAllowed(false);}
    setError(cause.message); setFields(Object.fromEntries(cause.fieldErrors.map(field => [field.path, field.message])));
    if (cause.details.utc_offsets && Array.isArray(cause.details.utc_offsets) && cause.details.utc_offsets.every(offset => typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset))) setOffsets(cause.details.utc_offsets as string[]);
    if (cause.code === 'version_conflict' && cause.details.latest_resource) {
      try {const latest = checkedOrder(cause.details.latest_resource); if (latest.id !== base?.id) throw new Error(); setConflict(latest);}
      catch {setError('The latest order could not be verified. Keep your draft and reload before saving.');}
    }
    setReview(false); setQuote(null); quoteDraft.current = null;
  }
  async function getQuote(forReview: boolean) {
    if (blocked || confirmOnly) return;
    const {draft, errors} = build(entry, settings);
    if (Object.keys(errors).length) {if (forReview) {setFields(errors); setError(null);} return;}
    const current = ++sequence.current; setQuoting(true); setError(null);
    try {
      const result = checkedQuote(await client.request('/orders/quote', {method: 'POST', body: {...(base ? {order_id: base.id, expected_version: base.version} : {}), draft}}));
      if (!active.current || current !== sequence.current) return;
      if (result.order_id !== (base?.id ?? null) || result.expected_version !== (base?.version ?? null) || result.settings_version !== settings.version
        || result.currency !== settings.currency || result.minor_digits !== settings.minor_digits || Date.parse(result.expires_at) <= client.now()
        || result.fulfillment.method !== draft.fulfillment.method || result.fulfillment.local_date !== draft.fulfillment.local_date || result.fulfillment.local_time !== draft.fulfillment.local_time
        || result.fulfillment.timezone !== draft.fulfillment.timezone || result.fulfillment.address !== draft.fulfillment.address || Boolean(draft.fulfillment.utc_offset && result.fulfillment.utc_offset !== draft.fulfillment.utc_offset)
        || result.lines.length !== draft.items.length || result.lines.some(line => !draft.items.some(item => item.client_line_id === line.client_line_id && item.variant_id === line.variant_id && item.quantity === line.quantity))) throw new Error('The quote could not be matched to this draft.');
      setQuote(result); quoteDraft.current = draft; setFields({}); if (forReview) setReview(true);
    } catch (cause) {if (active.current && current === sequence.current) failure(cause);}
    finally {if (active.current && current === sequence.current) setQuoting(false);}
  }
  useEffect(() => {
    if (confirmOnly || blocked || review) return;
    const timer = window.setTimeout(() => void getQuote(false), 450); return () => window.clearTimeout(timer);
    // Each entry revision gets a new quote; the sequence discards late responses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, base, confirmOnly, blocked, review]);
  async function send(next: Attempt) {
    if (saving.current) return; saving.current = true; setBusy(true); setError(null); setRetryAllowed(false); attempt.current = next;
    holdAttempt(orderOperationMarker, next);
    try {
      const result = checkedOrder(await client.request(next.path, {method: next.method, body: next.body, operationId: next.id}));
      if (base && result.id !== base.id) throw new Error('The saved order identity could not be verified.');
      if (!active.current) return; releaseAttempt(orderOperationMarker); onSaved(result);
    } catch (cause) {if (active.current) failure(cause, true);}
    finally {saving.current = false; if (active.current) setBusy(false);}
  }
  function save(status: 'pending' | 'confirmed') {
    if (blocked || saving.current || !review) return;
    if (confirmOnly && base) {void send({id: crypto.randomUUID(), path: `/orders/${encodeURIComponent(base.id)}/transitions`, method: 'POST', body: {expected_version: base.version, to_status: 'confirmed'}}); return;}
    if (!quote || !quoteDraft.current || Date.parse(quote.expires_at) <= client.now()) {setQuote(null); setReview(false); setError('Quote expired. Review the order again.'); return;}
    if (quote.credit_acknowledgment_required && !credit) return;
    void send({id: crypto.randomUUID(), path: base ? `/orders/${encodeURIComponent(base.id)}` : '/orders', method: base ? 'PUT' : 'POST', body: {
      quote_id: quote.id, draft: quoteDraft.current, acknowledge_credit: credit, ...(base ? {expected_version: base.version} : {initial_status: status})}});
  }
  async function reconcile() {
    const pending = attempt.current; if (!pending || saving.current) return;
    saving.current = true; setBusy(true); setRetryAllowed(false);
    try {
      const operation = await readOrderOperation(client, pending.id, controller.current.signal);
      if (!active.current) return;
      if (operation.state === 'succeeded') {releaseAttempt(orderOperationMarker); onSaved(operationOrder(operation.result!.body));}
      else if (operation.state === 'rejected') {const rejected = operation.error!; failure(new ApiError(rejected.http_status, rejected.error.code, rejected.error.message, rejected.error.field_errors, false, rejected.error.details), true);}
      else setError('Save is still processing. Check again before another submission.');
    } catch (cause) {if (active.current) {if (cause instanceof ApiError && cause.status === 404) {setRetryAllowed(true); setError('No save was recorded. You may retry the identical request with its original operation ID.');} else setError('Save status could not be verified. Check again.');}}
    finally {saving.current = false; if (active.current) setBusy(false);}
  }
  function close() {if (saving.current) return; if (dirty || uncertain) setDiscard(true); else onClose();}
  const choices = foods.filter(food => food.available && (settings.environment === 'development' || food.confirmation_status === 'confirmed')).flatMap(food => food.variants.filter(variant => variant.available
    && (settings.environment === 'development' || variant.confirmation_status === 'confirmed') && `${food.name} ${variant.label}`.toLowerCase().includes(search.toLowerCase())).map(variant => ({food, variant})));
  const field = (path: string) => fields[`/draft/${path}`];
  function textarea(label: string, key: 'customer_notes' | 'address' | 'notes', path: string, maxLength: number) {return <div className="field"><label htmlFor={`entry-${key}`}>{label}</label><textarea id={`entry-${key}`} maxLength={maxLength} value={entry[key]} onChange={e => change({[key]: e.target.value})} aria-invalid={Boolean(field(path))} aria-describedby={field(path) ? `entry-${key}-error` : undefined} />{field(path) && <p id={`entry-${key}-error`} className="field-error">{field(path)}</p>}</div>;}
  return <Dialog.Root open onOpenChange={open => {if (!open) close();}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content ref={content} className="editor-dialog order-editor" aria-describedby={undefined} onOpenAutoFocus={event => {if (!confirmOnly) {event.preventDefault(); form.current?.querySelector<HTMLInputElement>('#entry-name')?.focus();}}} onCloseAutoFocus={event => {event.preventDefault(); if (opener.current?.isConnected) opener.current.focus(); else document.getElementById('main-content')?.focus();}} onEscapeKeyDown={event => {event.preventDefault(); close();}} onPointerDownOutside={event => event.preventDefault()}>
    <div className="editor-heading"><div><Dialog.Title>{discard ? 'Discard changes?' : confirmOnly ? 'Review confirmation' : base ? 'Edit order' : 'New order'}</Dialog.Title><small>{settings.environment === 'development' ? 'Provisional settings' : 'Business settings'}: {settings.currency} / {settings.timezone}</small></div><IconButton label="Close order editor" disabled={busy} onClick={close}><X size={20} /></IconButton></div>
    {discard ? <><p className="discard-copy">{uncertain ? 'This save is still unresolved. Closing discards these entries; check or retry the save from the page.' : 'This order has unsaved changes.'}</p><div className="editor-actions"><button className="button secondary" onClick={() => setDiscard(false)}>Keep editing</button><button className="button danger" onClick={onClose}>Discard changes</button></div></> : <>
      {error && <Feedback error>{error}</Feedback>}
      {uncertain && <div className="editor-actions"><button className="button secondary" disabled={busy} onClick={() => void reconcile()}><RotateCw size={17} />Check save status</button>{retryAllowed && <button className="button secondary" disabled={busy} onClick={() => attempt.current && void send(attempt.current)}><RotateCw size={17} />Retry identical save</button>}</div>}
      {conflict && <section className="conflict-review"><h3>Latest saved order</h3><OrderReview value={conflict} customer={conflict.customer} notes={conflict.notes} /><div className="editor-actions"><button className="button secondary" disabled={!conflict.permitted_actions[confirmOnly ? 'confirm' : 'edit'].allowed} onClick={() => {setBase(conflict); setConflict(null); setError(null); setQuote(null); setReview(confirmOnly);}}>Keep draft with reviewed version</button>
        <button className="button secondary" onClick={() => {const next = entryFor(conflict, settings); setBase(conflict); initial.current = next; setEntry(next); setConflict(null); setError(null); setFields({}); setQuote(null); setReview(confirmOnly);}}>Replace draft with latest</button></div></section>}
      {base?.permitted_actions[confirmOnly ? 'confirm' : 'edit'].allowed === false && <Feedback>{base.permitted_actions[confirmOnly ? 'confirm' : 'edit'].reason}</Feedback>}
      {review && (confirmOnly && base || quote) ? <><OrderReview value={confirmOnly ? base! : quote!} customer={confirmOnly ? base!.customer : build(entry, settings).draft.customer} notes={entry.notes} />
        {quote?.credit_acknowledgment_required && <label className="checkbox-field"><input type="checkbox" checked={credit} onChange={e => setCredit(e.target.checked)} disabled={busy || uncertain} />Acknowledge customer credit of {formatMoney(quote.customer_credit_minor, quote)}</label>}
        <div className="editor-actions">{!confirmOnly && <button className="button secondary" disabled={busy || uncertain} onClick={() => setReview(false)}>Back to edit</button>}
        {!base && <button className="button secondary" disabled={blocked || Boolean(quote?.credit_acknowledgment_required && !credit)} onClick={() => save('pending')}><Save size={17} />Save pending</button>}
        <button className="button primary" disabled={blocked || Boolean(quote?.credit_acknowledgment_required && !credit)} onClick={() => save('confirmed')}><Check size={17} />{busy ? 'Saving...' : base && !confirmOnly ? 'Save changes' : 'Confirm order'}</button></div>
      </> : !confirmOnly && <form ref={form} noValidate onSubmit={event => {event.preventDefault(); void getQuote(true);}}>
        <fieldset className="order-entry-fields" disabled={busy || uncertain}>
          <section className="entry-section"><h3>Customer</h3><div className="entry-grid"><Field id="entry-name" label="Customer name" maxLength={200} value={entry.name} error={field('customer/name')} onChange={e => change({name: e.target.value})} /><Field id="entry-phone" label="Contact phone" type="tel" maxLength={50} value={entry.phone} error={field('customer/phone')} onChange={e => change({phone: e.target.value})} /></div>{textarea('Customer notes', 'customer_notes', 'customer/notes', 2000)}</section>
          <section className="entry-section"><h3>Fulfillment</h3><fieldset className="fulfillment-mode"><legend className="sr-only">Fulfillment method</legend>{offeredMethods(settings).map(method => <label key={method}><input type="radio" name="fulfillment" value={method} checked={entry.method === method} onChange={() => change({method})} />{method === 'pickup' ? 'Pickup' : 'Delivery'}</label>)}</fieldset>
            {(field('fulfillment/method') || entry.method === 'delivery' && settings.delivery_policy.mode === 'disabled') && <p className="field-error">{field('fulfillment/method') ?? deliveryDisabled}</p>}
            <div className="entry-grid"><Field id="entry-date" label="Fulfillment date" type="date" value={entry.date} error={field('fulfillment/local_date')} onChange={e => {setOffsets([]); change({date: e.target.value, offset: ''});}} /><Field id="entry-time" label="Fulfillment time" type="time" value={entry.time} error={field('fulfillment/local_time')} onChange={e => {setOffsets([]); change({time: e.target.value, offset: ''});}} /></div><small>{settings.timezone}</small>
            {offsets.length > 0 && <div className="field"><label htmlFor="entry-offset">Time occurrence (UTC offset)</label><select id="entry-offset" value={entry.offset} aria-invalid={Boolean(field('fulfillment/utc_offset'))} aria-describedby={field('fulfillment/utc_offset') ? 'entry-offset-error' : undefined} onChange={e => change({offset: e.target.value})}><option value="">Choose occurrence</option>{offsets.map(offset => <option key={offset}>{offset}</option>)}</select>{field('fulfillment/utc_offset') && <p className="field-error" id="entry-offset-error">{field('fulfillment/utc_offset')}</p>}</div>}
            {entry.method === 'delivery' ? textarea('Delivery address', 'address', 'fulfillment/address', 1000) : <p className="pickup-location">{settings.pickup_location}</p>}
          </section>
          <section className="entry-section"><h3>Items</h3>{menuLoading ? <Loading>Loading available menu...</Loading> : menuError ? <Feedback error>{menuError}<button type="button" className="text-action" onClick={() => setMenuRetry(value => value + 1)}>Retry menu</button></Feedback> : <>
            <Field id="entry-menu-search" label="Search available menu" value={search} onChange={e => setSearch(e.target.value)} suffix={<Search className="search-icon" size={18} />} /><div className="item-picker"><div className="field"><label htmlFor="entry-variant">Food and variant</label><select id="entry-variant" value={selected} aria-invalid={Boolean(field('items'))} aria-describedby={field('items') ? 'entry-items-error' : undefined} onChange={e => setSelected(e.target.value)}><option value="">Choose variant</option>{choices.map(({food, variant}) => <option key={variant.id} value={variant.id}>{food.name} - {variant.label} - {sellingLabel(variant.selling_unit, variant.package_contents)} - {formatMoney(variant.price_minor, settings)}{variant.confirmation_status === 'provisional' ? ' (provisional)' : ''}</option>)}</select></div>
            <button type="button" className="button secondary" disabled={!choices.some(choice => choice.variant.id === selected)} onClick={() => {const choice = choices.find(choice => choice.variant.id === selected)!; change({items: [...entry.items, {id: crypto.randomUUID(), variant: choice.variant, food_name: choice.food.name, quantity: '1', notes: ''}]});}}><Plus size={17} />Add item</button></div>{!choices.length && <p className="empty-state">No available variants match.</p>}</>}
            {field('items') && <p className="field-error" id="entry-items-error">{field('items')}</p>}
            {entry.items.map((item, index) => {const variant = item.saved ?? item.variant!; const prepared = item.saved?.prepared_quantity ?? 0; const quoted = quote?.lines.find(line => line.client_line_id === item.id); return <div className="draft-line" key={item.id}><div className="draft-line-heading"><div><strong>{item.food_name}</strong><small>{item.saved?.variant_label ?? item.variant?.label} / {sellingLabel(variant.selling_unit, variant.package_contents)} / {formatMoney(item.saved?.unit_price_minor ?? item.variant!.price_minor, settings)}</small></div><IconButton label={`Remove item ${index + 1}`} disabled={prepared > 0} onClick={() => change({items: entry.items.filter(row => row.id !== item.id)})}><Trash2 size={18} /></IconButton></div>
              {prepared > 0 && <p className="estimate-note">{`${prepared} already prepared. This item cannot be removed or reduced below ${prepared}.`}</p>}
              <div className="entry-grid"><Field id={`entry-quantity-${item.id}`} label={`Quantity for item ${index + 1}`} inputMode="numeric" value={item.quantity} error={field(`items/${index}/quantity`) ?? field(`items/${index}/variant_id`)} onChange={e => change({items: entry.items.map(row => row.id === item.id ? {...row, quantity: e.target.value} : row)})} /><Field id={`entry-note-${item.id}`} label={`Preparation notes for item ${index + 1}`} maxLength={1000} value={item.notes} error={field(`items/${index}/preparation_notes`)} onChange={e => change({items: entry.items.map(row => row.id === item.id ? {...row, notes: e.target.value} : row)})} /></div>{quoted && <p className="line-total">Line total <strong>{formatMoney(quoted.line_total_minor, quote!)}</strong></p>}
            </div>;})}
          </section>
          <section className="entry-section"><h3>Totals and notes</h3><div className="entry-grid">{entry.method === 'delivery' && (settings.delivery_policy.mode === 'manual_amount' ? <Field id="entry-delivery" label="Delivery charge" inputMode="decimal" value={entry.delivery} error={field('delivery_charge_minor')} onChange={e => change({delivery: e.target.value})} /> : settings.delivery_policy.mode === 'fixed_amount' && <div><small>Fixed delivery charge</small><p>{formatMoney(settings.delivery_policy.fixed_charge_minor!, settings)}</p></div>)}<Field id="entry-tax" label="Tax amount" inputMode="decimal" value={entry.tax} error={field('tax_minor')} onChange={e => change({tax: e.target.value})} /></div>{textarea('Order notes', 'notes', 'notes', 2000)}
            {quote ? <Amounts value={quote} /> : <p className="quote-state" role="status">{quoting ? 'Updating quote...' : 'Totals awaiting quote.'}</p>}
          </section>
        </fieldset><div className="editor-actions"><button type="submit" className="button primary" disabled={blocked}><Check size={17} />Review order</button></div>
      </form>}
    </>}
  </Dialog.Content></Dialog.Portal><NavigationGuard dirty={dirty || uncertain} busy={busy} onLeave={onClose} /></Dialog.Root>;
}
