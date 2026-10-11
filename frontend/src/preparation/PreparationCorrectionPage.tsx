import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Link, useNavigate, useParams} from 'react-router-dom';
import {Check, ChevronLeft, RotateCw, Save} from 'lucide-react';
import {ApiError} from '../api/client';
import {readOperation} from '../api/operations';
import {heldAttempt, holdAttempt, rejectedOutright, releaseAttempt} from '../api/pending';
import {Feedback} from '../components/ui';
import {useInventory} from '../inventory/InventoryArea';
import {scaledQuantity, validQuantity} from '../inventory/model';
import {ReadState} from '../inventory/reads';
import {checkedIngredient} from '../inventory/responses';
import type {Ingredient} from '../inventory/types';
import {statusLabel} from '../lib/format';
import {sellingLabel} from '../menu/model';
import {NavigationGuard} from '../orders/NavigationGuard';
import {checkedOrder} from '../orders/responses';
import type {Order} from '../orders/types';
import {correctionOperationMarker, preparationEnabled, signedQuantity} from './model';
import {checkedCorrectionOperation, checkedCorrectionPreview, checkedCorrectionResult, checkedPreparation} from './responses';
import type {CorrectionDraft, CorrectionPreview, CorrectionResult, Preparation} from './types';

type Loaded = {record: Preparation; orders: Map<string, Order>; ingredients: Map<string, Ingredient>};
type Attempt = {id: string; path: string; method: string; body: CorrectionDraft & {preview_id: string}};

export function PreparationCorrectionPage() {
  const {client, settings, revision} = useInventory(), {id = ''} = useParams(), navigate = useNavigate(), enabled = preparationEnabled(settings);
  const [loaded, setLoaded] = useState<Loaded | null>(null), [loadError, setLoadError] = useState(''), [reload, setReload] = useState(0);
  const [reason, setReason] = useState(''), [counts, setCounts] = useState<Record<string, string>>({}), [stock, setStock] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{draft: CorrectionDraft; preview: CorrectionPreview} | null>(null);
  const [error, setError] = useState(''), [fields, setFields] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false);
  const [marker, setMarker] = useState(() => sessionStorage.getItem(correctionOperationMarker)), [retryAllowed, setRetryAllowed] = useState(false), [done, setDone] = useState<string | null>(null);
  const active = useRef(true), controller = useRef(new AbortController()), saving = useRef(false), form = useRef<HTMLFormElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null), notice = useRef<HTMLDivElement>(null), returning = useRef(false);
  const dirty = Boolean(reason.trim()) || [...Object.values(counts), ...Object.values(stock)].some(value => value.trim()), unsettled = !done && (dirty || Boolean(marker));
  useEffect(() => {active.current = true; controller.current = new AbortController(); return () => {active.current = false; controller.current.abort();};}, []);
  // A correction quotes the current version of every order and ingredient it touches, so each is read with the record.
  useEffect(() => {
    let current = true; const reading = new AbortController(), signal = reading.signal; setLoaded(null); setLoadError('');
    if (!enabled) return;
    void (async () => {
      const record = checkedPreparation(await client.request(`/preparations/${encodeURIComponent(id)}`, {signal})), orders = new Map<string, Order>(), ingredients = new Map<string, Ingredient>();
      if (record.id !== id) throw new Error('Preparation record does not match this address.');
      for (const order of new Set(record.allocations.map(row => row.order_id))) orders.set(order, checkedOrder(await client.request(`/orders/${encodeURIComponent(order)}`, {signal})));
      for (const row of record.consumption) ingredients.set(row.ingredient_id, checkedIngredient(await client.request(`/ingredients/${encodeURIComponent(row.ingredient_id)}`, {signal})));
      if (current) setLoaded({record, orders, ingredients});
    })().catch(failure => {if (current) setLoadError((failure as Error).message);});
    return () => {current = false; reading.abort();};
  }, [client, id, revision, reload, enabled]);
  useEffect(() => {if (!unsettled && !busy) return; const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';}; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);}, [unsettled, busy]);
  useEffect(() => {
    if (busy) return;
    if (review) reviewHeading.current?.focus();
    else if (Object.keys(fields).length) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    else if (error) notice.current?.focus();
    else if (returning.current) form.current?.querySelector<HTMLElement>('textarea')?.focus();
    returning.current = false;
  }, [busy, review, fields, error]);
  useEffect(() => {if (done) navigate(`/preparations/${encodeURIComponent(done)}`, {state: {corrected: true}});}, [done, navigate]);
  if (!enabled) return <><h1>Preparation recording unavailable</h1><Feedback>Preparation recording is not enabled for this workspace.</Feedback></>;

  const locked = busy || Boolean(marker), path = `/preparations/${encodeURIComponent(id)}`;
  const edited = () => {setReview(null); setError(''); setFields({});};
  function build(): CorrectionDraft | null {
    const invalid: Record<string, string> = {}, allocations: CorrectionDraft['allocations'] = [], stock_corrections: CorrectionDraft['stock_corrections'] = [];
    if (!reason.trim()) invalid.reason = 'Enter a reason.';
    for (const row of loaded!.record.allocations) {
      const value = (counts[row.order_item_id] ?? '').trim(); if (!value) continue;
      if (!/^[+-]?\d{1,15}$/.test(value)) {invalid[`count:${row.order_item_id}`] = 'Enter a whole number such as -1 or 1.'; continue;}
      if (Number(value) !== 0) allocations.push({order_id: row.order_id, expected_version: loaded!.orders.get(row.order_id)!.version, order_item_id: row.order_item_id, delta_quantity: Number(value)});
    }
    for (const row of loaded!.record.consumption) {
      const value = (stock[row.ingredient_id] ?? '').trim().replace(/^\+/, ''); if (!value) continue;
      if (!validQuantity(value, row.base_unit, true)) {invalid[`stock:${row.ingredient_id}`] = row.base_unit === 'piece' ? 'Enter a signed whole count.' : 'Enter a signed quantity with up to three decimal places.'; continue;}
      if (scaledQuantity(value) !== 0n) stock_corrections.push({ingredient_id: row.ingredient_id, expected_version: loaded!.ingredients.get(row.ingredient_id)!.version, delta_base_quantity: value, corrects_movement_id: row.stock_movement_id});
    }
    const empty = !allocations.length && !stock_corrections.length && !Object.keys(invalid).some(key => key !== 'reason');
    setFields(invalid); setError(empty ? 'Enter at least one change to a prepared count or to stock.' : Object.keys(invalid).length ? 'Check the highlighted fields.' : '');
    return empty || Object.keys(invalid).length ? null : {reason: reason.trim(), allocations, stock_corrections};
  }
  function reject(failure: unknown, draft: CorrectionDraft) {
    setReview(null);
    if (!(failure instanceof ApiError)) {setFields({}); setError((failure as Error).message); return;}
    if (failure.code === 'version_conflict') {setFields({}); setError('Orders or stock changed after this page loaded. The latest figures are shown; check your entries and review again.'); setReload(value => value + 1); return;}
    const mapped: Record<string, string> = {}, other: string[] = [];
    for (const item of failure.fieldErrors ?? []) {
      const [, list, index] = /^\/(allocations|stock_corrections)\/(\d+)(?:\/|$)/.exec(item.path) ?? [], line = list === 'allocations' ? draft.allocations[Number(index)] : undefined, usage = list === 'stock_corrections' ? draft.stock_corrections[Number(index)] : undefined;
      const key = line ? `count:${line.order_item_id}` : usage ? `stock:${usage.ingredient_id}` : item.path === '/reason' ? 'reason' : null;
      if (key) mapped[key] = item.message; else other.push(item.message);
    }
    setFields(mapped); setError([failure.message, ...other].join(' '));
  }
  function recorded(result: CorrectionResult) {releaseAttempt(correctionOperationMarker); setMarker(null); setDone(result.correction.preparation_id);}
  async function send(next: Attempt) {
    if (saving.current) return; saving.current = true; setBusy(true); setError(''); setRetryAllowed(false); holdAttempt(correctionOperationMarker, next);
    const {preview_id: _preview, ...draft} = next.body;
    try {
      const value = await client.request(next.path, {method: next.method, body: next.body, operationId: next.id, signal: controller.current.signal}); if (!active.current) return;
      let result: CorrectionResult; try {result = checkedCorrectionResult(value, draft, next.id, id);} catch {throw new ApiError(200, 'invalid_response', 'Saved result could not be verified.', [], true);}
      recorded(result);
    } catch (failure) {
      if (!active.current) return;
      if (rejectedOutright(failure)) {releaseAttempt(correctionOperationMarker); setMarker(null); reject(failure, draft);}
      else {setMarker(next.id); setReview(null); setError('Save result unconfirmed. Check its status before another submission.');}
    } finally {saving.current = false; if (active.current) setBusy(false);}
  }
  async function checkStatus() {
    if (!marker || saving.current) return; saving.current = true; setBusy(true); setRetryAllowed(false);
    const held = heldAttempt(correctionOperationMarker) as Attempt | null;
    try {
      const operation = await readOperation(client, marker, (value, key) => checkedCorrectionOperation(value, key, id), controller.current.signal); if (!active.current) return;
      if (operation.state === 'succeeded') recorded(operation.result!.body);
      else if (operation.state === 'rejected') {
        releaseAttempt(correctionOperationMarker); setMarker(null); setError(`The earlier save was rejected: ${operation.error!.error.message}`);
        if (operation.error!.error.code === 'version_conflict') setReload(value => value + 1);
      } else setError('The earlier save is still processing. Check again before another submission.');
    } catch (failure) {
      if (!active.current) return;
      // The exact request stays in memory; without it a missing operation is an operator matter.
      const missing = failure instanceof ApiError && failure.status === 404; setRetryAllowed(missing && Boolean(held));
      setError(missing ? held ? 'No save was recorded. You may retry the identical request with its original operation ID.' : 'This operation is not recorded. The original draft is no longer available; ask an operator to reconcile it before another submission.'
        : 'Save status could not be verified. Check again.');
    } finally {saving.current = false; if (active.current) setBusy(false);}
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (saving.current || marker || !loaded) return;
    if (review) {
      if (Date.parse(review.preview.expires_at) <= client.now()) {setReview(null); setError('Preview expired. Review again before recording.'); return;}
      void send({id: crypto.randomUUID(), path: `${path}/corrections`, method: 'POST', body: {...review.draft, preview_id: review.preview.id}}); return;
    }
    const draft = build(); if (!draft) return;
    saving.current = true; setBusy(true);
    try {
      const preview = checkedCorrectionPreview(await client.request(`${path}/correction-preview`, {method: 'POST', body: draft, signal: controller.current.signal}), draft, id); if (!active.current) return;
      setReview({draft, preview}); setFields({}); setError('');
    } catch (failure) {if (active.current) reject(failure, draft);} finally {saving.current = false; if (active.current) setBusy(false);}
  }
  const preview = review?.preview;
  return <><NavigationGuard dirty={unsettled} busy={busy} onLeave={() => undefined} label="correction" />
    <div className="page-heading"><div><span className="eyebrow">PREPARATION RECORD</span><h1>Correct preparation</h1></div><Link className="button secondary" to={path}><ChevronLeft size={17} />Back to record</Link></div>
    {marker && <div className="menu-notice"><Feedback>{`Earlier correction save unresolved. Operation: ${marker}`}<button className="text-action" disabled={busy} onClick={() => void checkStatus()}><RotateCw size={16} />Check save status</button>
      {retryAllowed && <button className="text-action" disabled={busy} onClick={() => {const held = heldAttempt(correctionOperationMarker); if (held) void send(held as Attempt);}}><RotateCw size={16} />Retry identical save</button>}</Feedback></div>}
    {error && <div className="menu-notice" ref={notice} tabIndex={-1}><Feedback error>{error}</Feedback></div>}
    {!loaded ? <ReadState error={loadError || undefined} retry={() => setReload(value => value + 1)} loading="Loading preparation record..." /> : <form ref={form} onSubmit={event => void submit(event)} noValidate aria-busy={busy}>
      <fieldset className="order-entry-fields preparation-entry" disabled={locked} hidden={Boolean(review)}>
        <p className="estimate-note">The original record stays as it was. A correction is saved beside it with its own stock movements.</p>
        <div className="field"><label htmlFor="correction-reason">Reason for correction</label><textarea id="correction-reason" maxLength={2000} value={reason} aria-invalid={Boolean(fields.reason)} aria-describedby={fields.reason ? 'correction-reason-error' : undefined}
          onChange={event => {setReason(event.target.value); edited();}} />{fields.reason && <p className="field-error" id="correction-reason-error">{fields.reason}</p>}</div>
        <section className="page-section" aria-labelledby="correct-counts-heading"><h2 id="correct-counts-heading">Prepared counts</h2>
          <table className="ledger-table preparation-lines"><thead><tr><th>Food / variant</th><th>Order</th><th>Prepared</th><th>Change</th></tr></thead><tbody>{loaded.record.allocations.map(row => {
            const order = loaded.orders.get(row.order_id)!, item = order.items.find(entry => entry.id === row.order_item_id), key = `correct-count-${row.order_item_id}`, problem = fields[`count:${row.order_item_id}`];
            return <tr key={row.order_item_id}><th scope="row">{row.food_name}<small>{`${row.variant_label} / ${sellingLabel(row.selling_unit, row.package_contents)}`}</small></th>
              <td data-label="Order"><Link to={`/orders/${encodeURIComponent(row.order_id)}`}>{row.reference}</Link><small>{statusLabel(order.status)}</small></td>
              <td data-label="Prepared"><span>{item ? `${item.prepared_quantity ?? 0} of ${item.quantity} prepared` : 'Line no longer on the order'}</span><small>{`${row.quantity} recorded here`}</small></td>
              <td data-label="Change"><div className={`input-wrap${problem ? ' invalid' : ''}`}><input id={key} aria-label={`Change in prepared count, ${row.reference} ${row.variant_label} of ${row.food_name}`} maxLength={16} placeholder="0" value={counts[row.order_item_id] ?? ''}
                aria-invalid={Boolean(problem)} aria-describedby={problem ? `${key}-error` : undefined} onChange={event => {setCounts(current => ({...current, [row.order_item_id]: event.target.value})); edited();}} /></div>
                {problem && <p className="field-error" id={`${key}-error`}>{problem}</p>}</td></tr>;
          })}</tbody></table>
        </section>
        <section className="page-section" aria-labelledby="correct-stock-heading"><h2 id="correct-stock-heading">Stock adjustments</h2>
          {!loaded.record.consumption.length ? <p className="empty-state">This preparation deducted no tracked ingredients.</p> : <><p className="estimate-note">Enter a positive quantity for stock that is back on the shelf and a negative one for more that was used.</p>
            <table className="ledger-table preparation-lines"><thead><tr><th>Ingredient</th><th>Stock</th><th>Change</th></tr></thead><tbody>{loaded.record.consumption.map(row => {
              const ingredient = loaded.ingredients.get(row.ingredient_id)!, key = `correct-stock-${row.ingredient_id}`, problem = fields[`stock:${row.ingredient_id}`];
              return <tr key={row.ingredient_id}><th scope="row">{row.ingredient_name}</th>
                <td data-label="Stock"><span>{`In stock: ${ingredient.stock_on_hand} ${ingredient.base_unit}`}</span><small>{`Deducted here: ${row.base_quantity} ${row.base_unit}`}</small></td>
                <td data-label="Change"><div className={`input-wrap${problem ? ' invalid' : ''}`}><input id={key} aria-label={`${row.ingredient_name} stock change (${row.base_unit})`} inputMode="decimal" maxLength={24} placeholder="0" value={stock[row.ingredient_id] ?? ''}
                  aria-invalid={Boolean(problem)} aria-describedby={problem ? `${key}-error` : undefined} onChange={event => {setStock(current => ({...current, [row.ingredient_id]: event.target.value})); edited();}} /></div>
                  {problem && <p className="field-error" id={`${key}-error`}>{problem}</p>}</td></tr>;
            })}</tbody></table></>}
        </section>
      </fieldset>
      {preview && <section className="transaction-review" aria-labelledby="correction-review-heading"><h2 id="correction-review-heading" ref={reviewHeading} tabIndex={-1}>Review correction</h2>
        <p className="order-notes">{preview.reason}</p>
        {preview.allocations.length > 0 && <table className="snapshot-table"><thead><tr><th>Food / variant</th><th>Order</th><th>Prepared</th><th>Remaining</th></tr></thead><tbody>{preview.allocations.map(row => <tr key={row.order_item_id}>
          <th scope="row">{row.food_name}<small>{`${row.variant_label} / ${sellingLabel(row.selling_unit, row.package_contents)}`}</small></th><td data-label="Order">{row.reference}</td>
          <td data-label="Prepared">{`${row.prepared_before} -> ${row.prepared_after} of ${row.ordered_quantity}`}</td><td data-label="Remaining">{`${row.remaining_after} remaining`}</td></tr>)}</tbody></table>}
        {preview.stock_corrections.length > 0 && <table className="snapshot-table"><thead><tr><th>Ingredient</th><th>Change</th><th>Physical stock</th></tr></thead><tbody>{preview.stock_corrections.map(row => <tr key={row.ingredient_id}>
          <th scope="row">{row.ingredient_name}</th><td data-label="Change">{`${signedQuantity(row.delta_base_quantity)} ${row.base_unit}`}</td>
          <td data-label="Physical stock">{`${row.before_quantity} ${row.base_unit} -> ${row.after_quantity} ${row.base_unit}`}</td></tr>)}</tbody></table>}
        <p className="estimate-note">Recording changes these prepared counts and this stock once. A lowered count returns to what remains to prepare.</p>
      </section>}
      <div className="editor-actions">{review && <button type="button" className="button secondary" disabled={busy} onClick={() => {returning.current = true; setReview(null);}}>Edit correction</button>}
        <button type="submit" className="button primary" disabled={locked}>{review ? <Save size={17} /> : <Check size={17} />}{busy ? 'Working...' : review ? 'Record correction' : 'Review correction'}</button></div>
    </form>}
  </>;
}
