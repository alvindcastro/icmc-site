import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Link, useNavigate, useSearchParams} from 'react-router-dom';
import {Check, ChevronLeft, Plus, RotateCw, Save, Search, Trash2} from 'lucide-react';
import {ApiError} from '../api/client';
import {readOperation} from '../api/operations';
import {heldAttempt, holdAttempt, rejectedOutright, releaseAttempt} from '../api/pending';
import {Feedback, Field, IconButton} from '../components/ui';
import {scaledQuantity, validQuantity} from '../inventory/model';
import {InventoryPagination, ReadState, useInventoryRecord} from '../inventory/reads';
import {checkedIngredient} from '../inventory/responses';
import type {BaseUnit, Ingredient, PhysicalUnit} from '../inventory/types';
import {businessDate, formatCalendarDate, formatMoney, statusLabel} from '../lib/format';
import {sellingLabel} from '../menu/model';
import {checkedPage} from '../menu/responses';
import {NavigationGuard} from '../orders/NavigationGuard';
import {useOrders} from '../orders/OrderArea';
import {periodLabel} from '../planning/PlanningPage';
import {checkedPlanning} from '../planning/responses';
import {preparationEnabled, preparationOperationMarker} from './model';
import {checkedPreparationOperation, checkedPreparationPreview, checkedPreparationResult} from './responses';
import type {PreparationDraft, PreparationPreview, PreparationResult} from './types';

type Row = {ingredient: Ingredient; quantity: string; unit: PhysicalUnit};
type Attempt = {id: string; path: string; method: string; body: {preview_id: string; draft: PreparationDraft}};
const ingredientsPage = (value: unknown) => checkedPage(value, checkedIngredient);
const physicalUnits = (base: BaseUnit): PhysicalUnit[] => base === 'g' ? ['g', 'kg'] : base === 'ml' ? ['ml', 'l'] : ['piece'];
const validDate = (value: string) => {try {return Boolean(formatCalendarDate(value));} catch {return false;}};

export function PreparationPage() {
  const {client, settings, revision} = useOrders(), [params] = useSearchParams(), navigate = useNavigate(), enabled = preparationEnabled(settings);
  const from = params.get('date_from'), to = params.get('date_to'), period = from && to ? `?${new URLSearchParams({date_from: from, date_to: to})}` : '';
  const plan = useInventoryRecord(client, revision, enabled ? `/planning${period}` : null, checkedPlanning);
  const [query, setQuery] = useState(''), [pickerPage, setPickerPage] = useState(1);
  const picker = useInventoryRecord(client, revision, enabled ? `/ingredients?q=${encodeURIComponent(query)}&page=${pickerPage}` : null, ingredientsPage);
  const [preparedOn, setPreparedOn] = useState(() => businessDate(settings.timezone, client.now()));
  const [counts, setCounts] = useState<Record<string, string>>({}), [rows, setRows] = useState<Row[]>([]), [note, setNote] = useState('');
  const [review, setReview] = useState<{draft: PreparationDraft; preview: PreparationPreview} | null>(null);
  const [error, setError] = useState(''), [fields, setFields] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false);
  const [marker, setMarker] = useState(() => sessionStorage.getItem(preparationOperationMarker)), [retryAllowed, setRetryAllowed] = useState(false), [done, setDone] = useState<string | null>(null);
  const active = useRef(true), controller = useRef(new AbortController()), saving = useRef(false), form = useRef<HTMLFormElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null), notice = useRef<HTMLDivElement>(null), returning = useRef(false), added = useRef('');
  const dirty = Object.values(counts).some(value => value.trim()) || rows.length > 0 || Boolean(note.trim()), unsettled = !done && (dirty || Boolean(marker));
  useEffect(() => {active.current = true; controller.current = new AbortController(); return () => {active.current = false; controller.current.abort();};}, []);
  useEffect(() => {if (!unsettled && !busy) return; const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';}; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);}, [unsettled, busy]);
  // The submit button is disabled while a request runs, which drops keyboard focus; each outcome puts it somewhere useful.
  useEffect(() => {
    if (busy) return;
    if (review) reviewHeading.current?.focus();
    else if (Object.keys(fields).length) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    else if (error) notice.current?.focus();
    else if (returning.current) form.current?.querySelector<HTMLElement>('input')?.focus();
    returning.current = false;
  }, [busy, review, fields, error]);
  // A newly added ingredient is ready for its quantity straight away.
  useEffect(() => {if (added.current) {document.getElementById(`used-${added.current}`)?.focus(); added.current = '';}}, [rows]);
  // The saved record is opened only after the entry no longer guards the page.
  useEffect(() => {if (done) navigate(`/preparations/${encodeURIComponent(done)}`, {state: {recorded: true, returnTo: `/planning${period}`}});}, [done, navigate, period]);
  if (!enabled) return <><h1>Preparation recording unavailable</h1><Feedback>Preparation recording is not enabled for this workspace.</Feedback></>;

  const lines = plan.value ? plan.value.foods.flatMap(food => food.orders.filter(order => order.remaining_quantity > 0).map(order => ({food, order}))) : [];
  const permission = plan.value?.permitted_actions.record_preparation, locked = busy || Boolean(marker);
  const edited = () => {setReview(null); setError(''); setFields({});};
  function build(): PreparationDraft | null {
    const invalid: Record<string, string> = {}, allocations: PreparationDraft['allocations'] = [];
    if (!validDate(preparedOn)) invalid.prepared_on = 'Choose a valid business date.';
    for (const {order} of lines) {
      const value = (counts[order.order_item_id] ?? '').trim(); if (!value) continue;
      if (!/^\d{1,15}$/.test(value) || Number(value) > order.remaining_quantity) {invalid[`count:${order.order_item_id}`] = `Enter a whole number from 0 to ${order.remaining_quantity}.`; continue;}
      if (Number(value) > 0) allocations.push({order_id: order.order_id, expected_version: order.order_version, order_item_id: order.order_item_id, quantity: Number(value)});
    }
    for (const row of rows) if (!validQuantity(row.quantity, row.unit === 'piece' ? 'piece' : 'g') || scaledQuantity(row.quantity) <= 0n) invalid[`usage:${row.ingredient.id}`] = row.unit === 'piece' ? 'Enter a positive whole count.' : 'Enter a positive quantity with up to three decimal places.';
    // Actual usage is entered explicitly; a recipe estimate is never substituted for it.
    if (!rows.length && !note.trim()) invalid.note = 'Add the ingredients used, or explain a preparation that used no tracked ingredients.';
    const missing = !allocations.length && !Object.keys(invalid).some(key => key.startsWith('count:'));
    setFields(invalid); setError(missing ? 'Enter a prepared quantity for at least one order line.' : Object.keys(invalid).length ? 'Check the highlighted fields.' : '');
    return missing || Object.keys(invalid).length ? null : {prepared_on: preparedOn, allocations, note: note.trim(),
      consumption: rows.map(row => ({ingredient_id: row.ingredient.id, expected_version: row.ingredient.version, quantity: row.quantity, unit: row.unit}))};
  }
  async function refresh() {
    plan.retry();
    try {
      const latest = await Promise.all(rows.map(async row => checkedIngredient(await client.request(`/ingredients/${encodeURIComponent(row.ingredient.id)}`, {signal: controller.current.signal}))));
      if (active.current) setRows(current => current.map(row => ({...row, ingredient: latest.find(item => item.id === row.ingredient.id) ?? row.ingredient})));
    } catch {if (active.current) setError('Orders or stock changed, and the latest stock could not be loaded. Reload the page before reviewing again.');}
  }
  function reject(failure: unknown, draft: PreparationDraft) {
    setReview(null);
    if (!(failure instanceof ApiError)) {setFields({}); setError((failure as Error).message); return;}
    if (failure.code === 'version_conflict') {setFields({}); setError('Orders or stock changed after this page loaded. The latest figures are shown; check your entries and review again.'); void refresh(); return;}
    // Backend field paths index the submitted draft; they are shown on the order line or ingredient they belong to.
    const mapped: Record<string, string> = {}, other: string[] = [];
    for (const item of failure.fieldErrors ?? []) {
      const [, list, index] = /^\/draft\/(allocations|consumption)\/(\d+)(?:\/|$)/.exec(item.path) ?? [], allocation = list === 'allocations' ? draft.allocations[Number(index)] : undefined, usage = list === 'consumption' ? draft.consumption[Number(index)] : undefined;
      const key = allocation ? `count:${allocation.order_item_id}` : usage ? `usage:${usage.ingredient_id}` : item.path === '/draft/note' ? 'note' : item.path === '/draft/prepared_on' ? 'prepared_on' : null;
      if (key) mapped[key] = item.message; else other.push(item.message);
    }
    setFields(mapped); setError([failure.message, ...other].join(' '));
  }
  function recorded(result: PreparationResult) {releaseAttempt(preparationOperationMarker); setMarker(null); setDone(result.preparation.id);}
  async function send(next: Attempt) {
    if (saving.current) return; saving.current = true; setBusy(true); setError(''); setRetryAllowed(false); holdAttempt(preparationOperationMarker, next);
    try {
      const value = await client.request(next.path, {method: next.method, body: next.body, operationId: next.id, signal: controller.current.signal}); if (!active.current) return;
      let result: PreparationResult; try {result = checkedPreparationResult(value, next.body.draft, next.id);} catch {throw new ApiError(200, 'invalid_response', 'Saved result could not be verified.', [], true);}
      recorded(result);
    } catch (failure) {
      if (!active.current) return;
      if (rejectedOutright(failure)) {releaseAttempt(preparationOperationMarker); setMarker(null); reject(failure, next.body.draft);}
      else {setMarker(next.id); setReview(null); setError('Save result unconfirmed. Check its status before another submission.');}
    } finally {saving.current = false; if (active.current) setBusy(false);}
  }
  async function checkStatus() {
    if (!marker || saving.current) return; saving.current = true; setBusy(true); setRetryAllowed(false);
    const held = heldAttempt(preparationOperationMarker) as Attempt | null;
    try {
      const operation = await readOperation(client, marker, checkedPreparationOperation, controller.current.signal); if (!active.current) return;
      if (operation.state === 'succeeded') {
        let result: PreparationResult; try {result = checkedPreparationResult(operation.result!.body, held?.body.draft ?? null, marker);} catch {throw new Error('The recorded preparation does not match this submission. Ask an operator to review it before another submission.');}
        recorded(result);
      } else if (operation.state === 'rejected') {
        releaseAttempt(preparationOperationMarker); setMarker(null); setError(`The earlier save was rejected: ${operation.error!.error.message}`);
        if (operation.error!.error.code === 'version_conflict') void refresh();
      } else setError('The earlier save is still processing. Check again before another submission.');
    } catch (failure) {
      if (!active.current) return;
      // The exact request stays in memory; without it a missing operation is an operator matter.
      const missing = failure instanceof ApiError && failure.status === 404; setRetryAllowed(missing && Boolean(held));
      setError(missing ? held ? 'No save was recorded. You may retry the identical request with its original operation ID.' : 'This operation is not recorded. The original draft is no longer available; ask an operator to reconcile it before another submission.'
        : failure instanceof ApiError ? 'Save status could not be verified. Check again.' : (failure as Error).message);
    } finally {saving.current = false; if (active.current) setBusy(false);}
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (saving.current || marker) return;
    if (review) {
      if (Date.parse(review.preview.expires_at) <= client.now()) {setReview(null); setError('Preview expired. Review again before recording.'); return;}
      void send({id: crypto.randomUUID(), path: '/preparations', method: 'POST', body: {preview_id: review.preview.id, draft: review.draft}}); return;
    }
    const draft = build(); if (!draft) return;
    saving.current = true; setBusy(true);
    try {
      const preview = checkedPreparationPreview(await client.request('/preparations/preview', {method: 'POST', body: {draft}, signal: controller.current.signal}), draft); if (!active.current) return;
      if (preview.currency !== settings.currency || preview.minor_digits !== settings.minor_digits) throw new Error('Preview does not match this submission.');
      setReview({draft, preview}); setFields({}); setError('');
    } catch (failure) {if (active.current) reject(failure, draft);} finally {saving.current = false; if (active.current) setBusy(false);}
  }
  const preview = review?.preview, unknownCost = preview?.cost_basis_snapshots.filter(basis => basis.unit_cost === null).map(basis => preview.consumption.find(row => row.ingredient_id === basis.ingredient_id)!.ingredient_name) ?? [];
  return <><NavigationGuard dirty={unsettled} busy={busy} onLeave={() => undefined} label="preparation" />
    <div className="page-heading"><div><span className="eyebrow">PREPARATION</span><h1>Record preparation</h1></div><Link className="button secondary" to={`/planning${period}`}><ChevronLeft size={17} />Back to planning</Link></div>
    {marker && <div className="menu-notice"><Feedback>{`Earlier preparation save unresolved. Operation: ${marker}`}<button className="text-action" disabled={busy} onClick={() => void checkStatus()}><RotateCw size={16} />Check save status</button>
      {retryAllowed && <button className="text-action" disabled={busy} onClick={() => {const held = heldAttempt(preparationOperationMarker); if (held) void send(held as Attempt);}}><RotateCw size={16} />Retry identical save</button>}</Feedback></div>}
    {error && <div className="menu-notice" ref={notice} tabIndex={-1}><Feedback error>{error}</Feedback></div>}
    {!plan.value ? <ReadState error={plan.error} retry={plan.retry} loading="Loading remaining preparation..." /> : permission && !permission.allowed ? <Feedback>{permission.reason}</Feedback>
      : <form ref={form} onSubmit={event => void submit(event)} noValidate aria-busy={busy}>
        <fieldset className="order-entry-fields preparation-entry" disabled={locked} hidden={Boolean(review)}>
          <div className="menu-count"><span>{periodLabel(plan.value.period)}</span><small>{settings.timezone}</small></div>
          <div className="entry-grid"><Field id="prepared-on" label="Prepared on" type="date" value={preparedOn} error={fields.prepared_on} onChange={event => {setPreparedOn(event.target.value); edited();}} /></div>
          <section className="page-section" aria-labelledby="prepared-heading"><h2 id="prepared-heading">Food prepared</h2>
            {!lines.length ? <p className="empty-state">Nothing remains to prepare for this period.</p> : <table className="ledger-table preparation-lines"><thead><tr><th>Food / variant</th><th>Order</th><th>Remaining</th><th>Prepared now</th></tr></thead>
              <tbody>{lines.map(({food, order}) => {
                const id = `count-${order.order_item_id}`, problem = fields[`count:${order.order_item_id}`];
                return <tr key={order.order_item_id}><th scope="row">{food.food_name}<small>{`${food.variant_label} / ${sellingLabel(food.selling_unit, food.package_contents)}`}</small></th>
                  <td data-label="Order"><Link to={`/orders/${encodeURIComponent(order.order_id)}`}>{order.reference}</Link><small>{statusLabel(order.status)}</small></td>
                  <td data-label="Remaining">{`${order.remaining_quantity} of ${order.ordered_quantity} remaining`}</td>
                  <td data-label="Prepared now"><div className={`input-wrap${problem ? ' invalid' : ''}`}><input id={id} aria-label={`Prepared now, ${order.reference} ${food.variant_label} of ${food.food_name}`} inputMode="numeric" maxLength={15} placeholder="0"
                    value={counts[order.order_item_id] ?? ''} aria-invalid={Boolean(problem)} aria-describedby={problem ? `${id}-error` : undefined} onChange={event => {setCounts(current => ({...current, [order.order_item_id]: event.target.value})); edited();}} /></div>
                    {problem && <p className="field-error" id={`${id}-error`}>{problem}</p>}</td></tr>;
              })}</tbody></table>}
          </section>
          <section className="page-section" aria-labelledby="used-heading"><h2 id="used-heading">Ingredients used</h2>
            <p className="estimate-note">Enter what was actually used. A recipe estimate is never recorded in its place.</p>
            {rows.map(row => {
              const id = row.ingredient.id, change = (changes: Partial<Row>) => {setRows(current => current.map(item => item.ingredient.id === id ? {...item, ...changes} : item)); edited();};
              return <section className="draft-line" key={id}><div className="draft-line-heading"><div><strong>{row.ingredient.name}</strong><small>{`In stock: ${row.ingredient.stock_on_hand} ${row.ingredient.base_unit}`}</small></div>
                  <IconButton label={`Remove ${row.ingredient.name}`} onClick={() => {setRows(current => current.filter(item => item.ingredient.id !== id)); edited();}}><Trash2 size={18} /></IconButton></div>
                <div className="entry-grid"><Field id={`used-${id}`} label={`${row.ingredient.name} quantity used`} inputMode="decimal" maxLength={20} value={row.quantity} error={fields[`usage:${id}`]} onChange={event => change({quantity: event.target.value})} />
                  <div className="field"><label htmlFor={`unit-${id}`}>{`${row.ingredient.name} unit`}</label><select id={`unit-${id}`} value={row.unit} onChange={event => change({unit: event.target.value as PhysicalUnit})}>
                    {physicalUnits(row.ingredient.base_unit).map(unit => <option key={unit} value={unit}>{unit}</option>)}</select></div></div></section>;
            })}
            <Field id="find-used-ingredient" label="Find ingredient" value={query} maxLength={200} onChange={event => {setQuery(event.target.value); setPickerPage(1);}} suffix={<Search size={18} className="search-icon" />} />
            {!picker.value ? <ReadState error={picker.error} retry={picker.retry} loading="Loading ingredient choices..." /> : <><div className="ingredient-picker">{picker.value.items.map(item =>
              <button type="button" className="button secondary" key={item.id} disabled={rows.length >= 100 || rows.some(row => row.ingredient.id === item.id)} onClick={() => {added.current = item.id; setRows(current => [...current, {ingredient: item, quantity: '', unit: item.base_unit}]); edited();}}><Plus size={16} />Add {item.name}</button>)}</div>
              {!picker.value.items.length && <p>No ingredients match.</p>}<InventoryPagination value={picker.value} label="ingredient choices" change={setPickerPage} /></>}
          </section>
          <div className="field"><label htmlFor="preparation-note">Note</label><textarea id="preparation-note" maxLength={2000} value={note} aria-invalid={Boolean(fields.note)} aria-describedby={fields.note ? 'preparation-note-error' : undefined}
            onChange={event => {setNote(event.target.value); edited();}} />{fields.note && <p className="field-error" id="preparation-note-error">{fields.note}</p>}</div>
        </fieldset>
        {preview && <section className="transaction-review" aria-labelledby="review-heading"><h2 id="review-heading" ref={reviewHeading} tabIndex={-1}>Review before recording</h2>
          <dl className="order-facts"><div><dt>Prepared on</dt><dd>{formatCalendarDate(preview.prepared_on)}</dd></div>
            <div><dt>Estimated ingredient cost</dt><dd>{preview.estimate_complete ? formatMoney(preview.estimated_ingredient_cost_minor!, preview) : 'Unknown'}</dd></div></dl>
          {unknownCost.length > 0 && <Feedback>{`No purchase is recorded for ${unknownCost.join(', ')}, so the cost of this preparation is unknown rather than zero.`}</Feedback>}
          <table className="snapshot-table"><thead><tr><th>Food / variant</th><th>Order</th><th>Prepared</th><th>Remaining</th></tr></thead><tbody>{preview.allocations.map(row => {
            const recipe = preview.recipe_snapshots.find(snapshot => snapshot.variant_id === row.variant_id);
            return <tr key={row.order_item_id}><th scope="row">{row.food_name}<small>{`${row.variant_label} / ${sellingLabel(row.selling_unit, row.package_contents)}`}</small><small>{recipe?.recipe_version ? `Recipe version ${recipe.recipe_version}` : 'No recipe recorded'}</small></th>
              <td data-label="Order">{row.reference}</td><td data-label="Prepared">{`${row.prepared_before} -> ${row.prepared_after} of ${row.ordered_quantity}`}</td><td data-label="Remaining">{`${row.remaining_after} remaining`}</td></tr>;
          })}</tbody></table>
          {preview.consumption.length ? <table className="snapshot-table"><thead><tr><th>Ingredient</th><th>Used</th><th>Physical stock</th></tr></thead><tbody>{preview.consumption.map(row => <tr key={row.ingredient_id}><th scope="row">{row.ingredient_name}</th>
            <td data-label="Used"><span>{`${row.quantity} ${row.unit}`}</span>{row.unit !== row.base_unit && <small>{`${row.base_quantity} ${row.base_unit}`}</small>}</td>
            <td data-label="Physical stock">{`${row.before_quantity} ${row.base_unit} -> ${row.after_quantity} ${row.base_unit}`}</td></tr>)}</tbody></table> : <p className="empty-state">No tracked ingredients were used.</p>}
          {preview.note && <p className="order-notes">{preview.note}</p>}
          <p className="estimate-note">Recording deducts this stock once. Editing or cancelling an order later does not return it; corrections are separate stock movements.</p>
        </section>}
        <div className="editor-actions">{review && <button type="button" className="button secondary" disabled={busy} onClick={() => {returning.current = true; setReview(null);}}>Edit entries</button>}
          <button type="submit" className="button primary" disabled={locked || !lines.length}>{review ? <Save size={17} /> : <Check size={17} />}{busy ? 'Working...' : review ? 'Record preparation' : 'Review preparation'}</button></div>
      </form>}
  </>;
}
