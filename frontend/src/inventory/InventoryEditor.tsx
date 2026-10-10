import * as Dialog from '@radix-ui/react-dialog';
import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Check, Plus, RotateCw, Save, Search, Trash2, X} from 'lucide-react';
import {ApiError} from '../api/client';
import {holdAttempt, releaseAttempt} from '../api/pending';
import {Feedback, Field, IconButton} from '../components/ui';
import {formatCalendarDate, formatMoney} from '../lib/format';
import {parsePrice} from '../menu/model';
import {checkedPage} from '../menu/responses';
import {NavigationGuard} from '../orders/NavigationGuard';
import {useInventory} from './InventoryArea';
import {comparableCost, scaledQuantity, validQuantity} from './model';
import {checkedIngredient, checkedInventoryResult, checkedMovement, checkedMovementPreview, checkedPurchasePreview} from './responses';
import {readInventoryOperation} from './operations';
import {InventoryPagination, ReadState, useInventoryRecord} from './reads';
import type {BaseUnit, Ingredient, InventoryResult, MovementInput, MovementPreview, PurchaseDraft, PurchasePreview, PurchaseUnit} from './types';

export const inventoryOperationMarker = 'food-reservations:inventory-operation';
export type EditorTarget = {kind: 'ingredient'; ingredient?: Ingredient} | {kind: 'movement'; ingredient: Ingredient; action: MovementInput['type']} | {kind: 'purchase'};
type Row = {id: string; ingredient: Ingredient; quantity: string; unit: PurchaseUnit; contents: string; contentsUnit: BaseUnit | 'kg' | 'l'; cost: string};
type Draft = {name: string; baseUnit: BaseUnit; threshold: string; delta: string; reason: string; related: string; purchasedOn: string; supplier: string; note: string; rows: Row[]};
type Attempt = {id: string; path: string; method: string; body: any};
const ingredientsPage = (value: unknown) => checkedPage(value, checkedIngredient), movementsPage = (value: unknown) => checkedPage(value, checkedMovement);
const physicalUnits = (base: BaseUnit) => base === 'g' ? ['g', 'kg'] as const : base === 'ml' ? ['ml', 'l'] as const : ['piece'] as const;
function today(timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}
function Select({id, label, value, change, options, error, disabled}: {id: string; label: string; value: string; change: (value: string) => void; options: {value: string; label: string}[]; error?: string; disabled?: boolean}) {
  return <div className="field"><label htmlFor={id}>{label}</label><select id={id} value={value} disabled={disabled} onChange={e => change(e.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}>{options.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>{error && <p className="field-error" id={`${id}-error`}>{error}</p>}</div>;
}
export function InventoryEditor({target, onClose, onSaved}: {target: EditorTarget; onClose: () => void; onSaved: (result: InventoryResult) => void}) {
  const {client, settings, revision} = useInventory();
  const [base, setBase] = useState(target.kind === 'purchase' ? undefined : target.ingredient);
  const initial = useRef<Draft>({name: base?.name ?? '', baseUnit: base?.base_unit ?? 'g', threshold: base?.low_stock_threshold ?? '', delta: '', reason: '', related: '', purchasedOn: today(settings.timezone), supplier: '', note: '', rows: []});
  const [draft, setDraft] = useState(initial.current), [fields, setFields] = useState<Record<string,string>>({}), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), saving = useRef(false), [discard, setDiscard] = useState(false), [conflict, setConflict] = useState<Ingredient | null>(null);
  const [unverifiedConflict, setUnverifiedConflict] = useState<{id: string | null} | null>(null);
  const [review, setReview] = useState<{body: PurchaseDraft | MovementInput; preview: PurchasePreview | MovementPreview} | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null), [uncertain, setUncertain] = useState(false), [retryAllowed, setRetryAllowed] = useState(false);
  const [query, setQuery] = useState(''), [pickerPage, setPickerPage] = useState(1), [movementChoicePage, setMovementChoicePage] = useState(1);
  const active = useRef(true), controller = useRef(new AbortController()), form = useRef<HTMLFormElement>(null), returnFocus = useRef(document.activeElement as HTMLElement | null);
  const permission = target.kind === 'purchase' ? undefined : base?.permitted_actions[target.kind === 'movement' ? target.action : 'edit'];
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial.current), locked = busy || uncertain || permission?.allowed === false;
  const picker = useInventoryRecord(client, revision, target.kind === 'purchase' ? `/ingredients?q=${encodeURIComponent(query)}&page=${pickerPage}` : null, ingredientsPage);
  const movements = useInventoryRecord(client, revision, target.kind === 'movement' && target.action === 'correction' ? `/ingredients/${encodeURIComponent(base!.id)}/movements?page=${movementChoicePage}` : null, movementsPage);
  const title = target.kind === 'purchase' ? 'Record purchase' : target.kind === 'movement' ? target.action === 'opening' ? 'Opening stock' : target.action === 'waste' ? 'Record waste' : 'Correct stock' : `${base ? 'Edit' : 'Add'} ingredient`;
  useEffect(() => {active.current = true; controller.current = new AbortController(); return () => {active.current = false; controller.current.abort();};}, []);
  useEffect(() => {if (!dirty && !uncertain && !busy) return; const warn = (e: BeforeUnloadEvent) => {e.preventDefault(); e.returnValue = '';}; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);}, [dirty, uncertain, busy]);
  useEffect(() => {if (!busy && !discard && Object.keys(fields).length) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();}, [busy, discard, fields]);
  function change<K extends keyof Draft>(key: K, value: Draft[K]) {setDraft(old => ({...old, [key]: value})); setReview(null); setError(''); setFields({});}
  function rowChange(index: number, changes: Partial<Row>) {change('rows', draft.rows.map((row, i) => i === index ? {...row, ...changes} : row));}
  function close() {if (saving.current) return; if (dirty || uncertain) setDiscard(true); else onClose();}
  function reject(failure: ApiError, mutation = false) {
    setReview(null);
    if (mutation && (failure.uncertain || ['operation_in_progress','operation_payload_mismatch'].includes(failure.code))) {setUncertain(true); setError('Save result unconfirmed. Check its status before another submission.'); return;}
    if (mutation) {releaseAttempt(inventoryOperationMarker); setAttempt(null); setUncertain(false); setRetryAllowed(false);}
    setError(failure.message); setFields(Object.fromEntries((failure.fieldErrors ?? []).map(item => [item.path, item.message])));
    if (failure.code === 'version_conflict') {try {const latest = checkedIngredient(failure.details.latest_resource); if (base && latest.id !== base.id || target.kind === 'purchase' && !draft.rows.some(row => row.ingredient.id === latest.id)) throw new Error(); setConflict(latest);} catch {
      const id = base?.id ?? (draft.rows.some(row => row.ingredient.id === failure.details.resource_id) ? String(failure.details.resource_id) : null);
      setUnverifiedConflict({id}); setError('Latest stock could not be verified. Keep your draft and refresh before saving.');
    }}
  }
  function verifyResult(value: unknown, request: Attempt) {
    const result = checkedInventoryResult(value);
    if (target.kind === 'purchase') {
      if (!('purchase' in result) || result.purchase.operation_id !== request.id || result.purchase.supplier !== request.body.draft.supplier
        || result.purchase.purchased_on !== request.body.draft.purchased_on || result.purchase.note !== request.body.draft.note || result.purchase.currency !== settings.currency || result.purchase.minor_digits !== settings.minor_digits
        || result.purchase.items.length !== request.body.draft.items.length || result.purchase.items.some((row, i) => {
          const input = request.body.draft.items[i];
          return row.ingredient_id !== input.ingredient_id || row.total_cost_minor !== input.total_cost_minor || row.quantity !== input.quantity || row.unit !== input.unit
            || (row.pack_contents === null ? input.pack_contents !== null : !input.pack_contents || row.pack_contents.quantity !== input.pack_contents.quantity || row.pack_contents.unit !== input.pack_contents.unit);
        })) throw new Error();
    } else if (target.kind === 'movement') {
      if (!('movement' in result) || result.ingredient.id !== base!.id || result.ingredient.version !== request.body.expected_version + 1 || result.movement.operation_id !== request.id
        || result.movement.type !== request.body.type || scaledQuantity(result.movement.delta_base_quantity) !== scaledQuantity(request.body.delta_base_quantity)) throw new Error();
    } else {
      if ('ingredient' in result || 'purchase' in result || base && result.id !== base.id || result.name !== request.body.name || result.base_unit !== draft.baseUnit
        || result.version !== (request.body.expected_version ?? 0) + 1 || (result.low_stock_threshold === null ? request.body.low_stock_threshold !== null : request.body.low_stock_threshold === null
          || scaledQuantity(result.low_stock_threshold) !== scaledQuantity(request.body.low_stock_threshold))
        || base && scaledQuantity(result.stock_on_hand) !== scaledQuantity(base.stock_on_hand) || !base && (scaledQuantity(result.stock_on_hand) !== 0n || result.latest_unit_cost !== null)) throw new Error();
    }
    return result;
  }
  async function send(next: Attempt) {
    if (saving.current) return; saving.current = true; setBusy(true); setError(''); setRetryAllowed(false); setAttempt(next); holdAttempt(inventoryOperationMarker, next);
    try {
      const value = await client.request(next.path, {method: next.method, body: next.body, operationId: next.id, signal: controller.current.signal}); if (!active.current) return;
      let result: InventoryResult; try {result = verifyResult(value, next);} catch {throw new ApiError(200, 'invalid_response', 'Saved result could not be verified.', [], true);}
      releaseAttempt(inventoryOperationMarker); onSaved(result);
    } catch (failure) {if (active.current) reject(failure as ApiError, true);} finally {saving.current = false; if (active.current) setBusy(false);}
  }
  async function checkStatus() {
    if (!attempt || saving.current) return; saving.current = true; setBusy(true); setRetryAllowed(false);
    try {
      const operation = await readInventoryOperation(client, attempt.id, controller.current.signal); if (!active.current) return;
      if (operation.state === 'succeeded') {let result: InventoryResult; try {result = verifyResult(operation.result!.body, attempt);} catch {throw new Error('Saved operation does not match this submission.');} releaseAttempt(inventoryOperationMarker); onSaved(result);}
      else if (operation.state === 'rejected') {const rejection = operation.error!; reject(new ApiError(rejection.http_status, rejection.error.code, rejection.error.message, rejection.error.field_errors, false, rejection.error.details), true);}
      else setError('The save is still processing. Check its status again.');
    } catch (failure) {if (active.current) {if (failure instanceof ApiError && failure.status === 404) {setRetryAllowed(true); setError('No operation recorded. Only the exact original submission may be retried.');} else setError((failure as Error).message);}}
    finally {saving.current = false; if (active.current) setBusy(false);}
  }
  function validate() {
    const errors: Record<string,string> = {};
    if (target.kind === 'ingredient') {
      if (!draft.name.trim()) errors['/name'] = 'Enter an ingredient name.';
      if (draft.threshold && !validQuantity(draft.threshold, draft.baseUnit)) errors['/low_stock_threshold'] = 'Enter a nonnegative compatible quantity with up to three decimal places; pieces are whole counts.';
    } else if (target.kind === 'movement') {
      if (!validQuantity(draft.delta, base!.base_unit, true) || scaledQuantity(draft.delta) === 0n) errors['/delta_base_quantity'] = 'Enter a nonzero compatible stock change.';
      if (!draft.reason.trim()) errors['/reason'] = 'Enter a reason.';
    } else {
      try {formatCalendarDate(draft.purchasedOn);} catch {errors['/draft/purchased_on'] = 'Choose a valid business date.';}
      if (!draft.supplier.trim()) errors['/draft/supplier'] = 'Enter a supplier.';
      if (!draft.rows.length) errors['/draft/items'] = 'Add at least one ingredient.';
      draft.rows.forEach((row, i) => {
        const packed = ['bag','bottle','box'].includes(row.unit), prefix = `/draft/items/${i}`;
        if (!validQuantity(row.quantity, packed ? 'piece' : row.ingredient.base_unit) || scaledQuantity(row.quantity) <= 0n) errors[`${prefix}/quantity`] = 'Enter a positive quantity; packs and pieces use whole counts.';
        if (packed && (!validQuantity(row.contents, row.ingredient.base_unit) || scaledQuantity(row.contents) <= 0n)) errors[`${prefix}/pack_contents/quantity`] = 'Declare positive contents per pack.';
        if (parsePrice(row.cost, settings.minor_digits) === null) errors[`${prefix}/total_cost_minor`] = `Enter a nonnegative total cost with up to ${settings.minor_digits} decimal places.`;
      });
    }
    setFields(errors); setError(''); return Object.keys(errors).length === 0;
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (saving.current || uncertain || conflict || unverifiedConflict) return;
    if (review) {
      if (Date.parse(review.preview.expires_at) <= client.now()) {setReview(null); setError('Preview expired. Review again before saving.'); return;}
      void send({id: crypto.randomUUID(), path: target.kind === 'purchase' ? '/purchases' : `/ingredients/${encodeURIComponent(base!.id)}/movements`, method: 'POST',
        body: target.kind === 'purchase' ? {preview_id: review.preview.id, draft: review.body} : {...review.body, preview_id: review.preview.id}}); return;
    }
    if (!validate()) return;
    if (target.kind === 'ingredient') {
      if (base && !base.permitted_actions.edit.allowed) return;
      void send({id: crypto.randomUUID(), path: base ? `/ingredients/${encodeURIComponent(base.id)}` : '/ingredients', method: base ? 'PATCH' : 'POST',
        body: {name: draft.name.trim(), low_stock_threshold: draft.threshold || null, ...(base ? {expected_version: base.version} : {base_unit: draft.baseUnit})}}); return;
    }
    if (target.kind === 'movement' && !base!.permitted_actions[target.action].allowed) return;
    const input: PurchaseDraft | MovementInput = target.kind === 'purchase' ? {purchased_on: draft.purchasedOn, supplier: draft.supplier.trim(), note: draft.note, items: draft.rows.map(row => ({client_line_id: row.id, ingredient_id: row.ingredient.id, quantity: row.quantity, unit: row.unit,
      pack_contents: ['bag','bottle','box'].includes(row.unit) ? {quantity: row.contents, unit: row.contentsUnit} : null, total_cost_minor: parsePrice(row.cost, settings.minor_digits)!}))}
      : {expected_version: base!.version, type: target.action, delta_base_quantity: draft.delta, reason: draft.reason.trim(), preparation_id: null, corrects_movement_id: draft.related || null};
    saving.current = true; setBusy(true);
    try {
      const value = await client.request(target.kind === 'purchase' ? '/purchases/preview' : `/ingredients/${encodeURIComponent(base!.id)}/movement-preview`, {method: 'POST', body: target.kind === 'purchase' ? {draft: input} : input, signal: controller.current.signal}); if (!active.current) return;
      const preview = target.kind === 'purchase' ? checkedPurchasePreview(value, input as PurchaseDraft) : checkedMovementPreview(value);
      if ('ingredient_id' in preview && (preview.ingredient_id !== base!.id || preview.expected_version !== base!.version || scaledQuantity(preview.delta_base_quantity) !== scaledQuantity(draft.delta))
        || 'currency' in preview && (preview.currency !== settings.currency || preview.minor_digits !== settings.minor_digits)) throw new Error('Preview does not match this submission.');
      setReview({body: input, preview}); setFields({});
    } catch (failure) {if (active.current) reject(failure as ApiError);} finally {saving.current = false; if (active.current) setBusy(false);}
  }
  const f = (path: string) => fields[path];
  return <><NavigationGuard dirty={dirty || uncertain} busy={busy} onLeave={onClose} label="inventory" />
    <Dialog.Root open onOpenChange={open => {if (!open) close();}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className={`editor-dialog ${target.kind === 'purchase' ? 'order-editor' : ''}`} aria-describedby={undefined}
      onOpenAutoFocus={event => {event.preventDefault(); form.current?.querySelector<HTMLInputElement>('input')?.focus();}} onCloseAutoFocus={event => {event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus();}}>
      <div className="editor-heading"><div><Dialog.Title>{discard ? 'Discard changes?' : title}</Dialog.Title>{base && <small>{base.name} / {base.base_unit}</small>}</div><IconButton label="Close editor" disabled={busy} onClick={close}><X size={20} /></IconButton></div>
      {discard ? <><p className="discard-copy">{uncertain ? 'This save is still unresolved. Closing discards these entries; check or retry the save from the page.' : 'Your unsaved changes will be lost.'}</p><div className="editor-actions"><button className="button secondary" onClick={() => setDiscard(false)}>Keep editing</button><button className="button danger" onClick={onClose}>Discard changes</button></div></> : <form ref={form} onSubmit={event => void submit(event)} noValidate aria-busy={busy}>
        <fieldset className="order-entry-fields" disabled={locked || Boolean(conflict) || Boolean(unverifiedConflict)} hidden={Boolean(review)}><div className="editor-fields">
          {target.kind === 'ingredient' ? <><Field id="ingredient-name" label="Ingredient name" value={draft.name} maxLength={200} onChange={e => change('name', e.target.value)} error={f('/name')} />
            <Select id="base-unit" label="Base unit" value={draft.baseUnit} disabled={Boolean(base)} change={value => change('baseUnit', value as BaseUnit)} options={[{value: 'g',label: 'Grams (g)'},{value:'ml',label:'Milliliters (ml)'},{value:'piece',label:'Pieces'}]} error={f('/base_unit')} />
            <Field id="stock-threshold" label="Low-stock threshold" inputMode="decimal" value={draft.threshold} onChange={e => change('threshold', e.target.value)} error={f('/low_stock_threshold')} /></> : target.kind === 'movement' ? <>
            <Field id="stock-delta" label={`Stock change (${base!.base_unit})`} inputMode="decimal" value={draft.delta} onChange={e => change('delta', e.target.value)} error={f('/delta_base_quantity')} />
            <Field id="movement-reason" label="Reason" maxLength={2000} value={draft.reason} onChange={e => change('reason', e.target.value)} error={f('/reason')} />
            {target.action === 'correction' && <>{!movements.value ? <ReadState error={movements.error} retry={movements.retry} loading="Loading related movements..." /> : <><Select id="related-movement" label="Related movement" value={draft.related} change={value => change('related',value)} error={f('/corrects_movement_id')}
              options={[{value:'',label:'No related movement'}, ...(draft.related && !movements.value.items.some(item => item.id === draft.related) ? [{value: draft.related, label: 'Selected related movement'}] : []), ...movements.value.items.map(item => ({value: item.id, label: `${item.type}: ${item.reason}`}))]} /><InventoryPagination value={movements.value} label="related movements" change={setMovementChoicePage} /></>}</>}
          </> : <><div className="entry-grid"><Field id="purchased-on" label="Purchased on" type="date" value={draft.purchasedOn} onChange={e => change('purchasedOn', e.target.value)} error={f('/draft/purchased_on')} />
            <Field id="supplier" label="Supplier" value={draft.supplier} maxLength={200} onChange={e => change('supplier',e.target.value)} error={f('/draft/supplier')} /></div>
            <Field id="purchase-note" label="Purchase note" maxLength={2000} value={draft.note} onChange={e => change('note', e.target.value)} error={f('/draft/note')} />
            <section className="entry-section"><h3>Ingredients</h3><Field id="find-ingredient" label="Find ingredient" value={query} maxLength={200} onChange={e => {setQuery(e.target.value); setPickerPage(1);}} suffix={<Search size={18} className="search-icon" />} />
              {!picker.value ? <ReadState error={picker.error} retry={picker.retry} loading="Loading ingredient choices..." /> : <><div className="ingredient-picker">{picker.value.items.map(item => <button type="button" className="button secondary" key={item.id} disabled={draft.rows.length >= 100} onClick={() => change('rows',[...draft.rows,{id: crypto.randomUUID(), ingredient: item, quantity:'', unit:item.base_unit, contents:'', contentsUnit:item.base_unit, cost:''}])}><Plus size={16} />Add {item.name}</button>)}</div>{!picker.value.items.length && <p>No ingredients match.</p>}<InventoryPagination value={picker.value} label="ingredient choices" change={setPickerPage} /></>}
              {f('/draft/items') && <Feedback error>{f('/draft/items')}</Feedback>}
              {draft.rows.map((row,i) => <section className="draft-line" key={row.id}><div className="draft-line-heading"><div><strong>{row.ingredient.name}</strong><small>Base unit: {row.ingredient.base_unit}</small></div><IconButton label={`Remove purchase line ${i+1}`} onClick={() => change('rows', draft.rows.filter(item => item.id !== row.id))}><Trash2 size={18} /></IconButton></div>
                {f(`/draft/items/${i}/ingredient_id`) && <Feedback error>{f(`/draft/items/${i}/ingredient_id`)}</Feedback>}
                <div className="entry-grid"><Field id={`quantity-${i}`} label={`Quantity ${i+1}`} inputMode="decimal" value={row.quantity} onChange={e => rowChange(i,{quantity:e.target.value})} error={f(`/draft/items/${i}/quantity`)} />
                  <Select id={`unit-${i}`} label={`Purchase unit ${i+1}`} value={row.unit} change={value => rowChange(i,{unit:value as PurchaseUnit})} options={[...physicalUnits(row.ingredient.base_unit), 'bag','bottle','box'].map(value => ({value,label:value}))} error={f(`/draft/items/${i}/unit`)} />
                  {['bag','bottle','box'].includes(row.unit) && <><Field id={`contents-${i}`} label={`Contents per pack ${i+1}`} inputMode="decimal" value={row.contents} onChange={e => rowChange(i,{contents:e.target.value})} error={f(`/draft/items/${i}/pack_contents/quantity`) ?? f(`/draft/items/${i}/pack_contents`)} />
                    <Select id={`contents-unit-${i}`} label={`Contents unit ${i+1}`} value={row.contentsUnit} change={value => rowChange(i,{contentsUnit:value as Row['contentsUnit']})} options={physicalUnits(row.ingredient.base_unit).map(value => ({value,label:value}))} error={f(`/draft/items/${i}/pack_contents/unit`)} /></>}
                  <Field id={`cost-${i}`} label={`Total ingredient cost ${i+1} (${settings.currency})`} inputMode="decimal" value={row.cost} onChange={e => rowChange(i,{cost:e.target.value})} error={f(`/draft/items/${i}/total_cost_minor`)} />
                </div></section>)}
            </section></>}
        </div></fieldset>
        {review && <section className="transaction-review"><h3>{target.kind === 'purchase' ? 'Review purchase' : 'Review stock movement'}</h3>{'items' in review.preview ? <>
          <dl className="order-facts"><div><dt>Supplier</dt><dd>{draft.supplier}</dd></div><div><dt>Purchased on</dt><dd>{formatCalendarDate(draft.purchasedOn)}</dd></div><div><dt>Total ingredient cost</dt><dd>{formatMoney(review.preview.total_cost_minor, review.preview)}</dd></div></dl>
          <table className="snapshot-table"><thead><tr><th>Ingredient</th><th>Normalized quantity / cost</th><th>Comparable cost</th><th>Physical stock</th></tr></thead><tbody>{review.preview.items.map((row,i) => <tr key={row.client_line_id}><th scope="row">{draft.rows[i].ingredient.name}<small>{draft.rows[i].quantity} {draft.rows[i].unit}</small>{['bag','bottle','box'].includes(draft.rows[i].unit) && <small>{draft.rows[i].contents} {draft.rows[i].contentsUnit} per {draft.rows[i].unit}</small>}</th><td data-label="Normalized quantity">{row.base_quantity} {row.base_unit}<small>Cost {formatMoney(row.total_cost_minor, settings)}</small></td><td data-label="Comparable cost">{comparableCost(row.unit_cost,row.base_unit,review.preview && 'currency' in review.preview ? review.preview.currency : settings.currency)}</td><td data-label="Physical stock">{row.before_quantity} {row.base_unit} -&gt; {row.after_quantity} {row.base_unit}</td></tr>)}</tbody></table>
        </> : <><p>{review.preview.before_quantity} {base!.base_unit} -&gt; {review.preview.after_quantity} {base!.base_unit}</p><dl className="order-facts"><div><dt>Stock change</dt><dd>{review.preview.delta_base_quantity} {base!.base_unit}</dd></div></dl><p className="order-notes">{draft.reason}</p></>}
          <button type="button" className="button secondary" disabled={busy} onClick={() => setReview(null)}>Back to entry</button></section>}
        {error && <Feedback error>{error}</Feedback>}
        {permission?.allowed === false && <Feedback error>{permission.reason}</Feedback>}
        {unverifiedConflict && <button type="button" className="button secondary" disabled={busy || !unverifiedConflict.id} onClick={() => {
          if (!unverifiedConflict.id || saving.current) return; const id = unverifiedConflict.id; saving.current = true; setBusy(true);
          void client.request(`/ingredients/${encodeURIComponent(id)}`, {signal:controller.current.signal}).then(value => {const latest = checkedIngredient(value); if(latest.id !== id) throw new Error('Latest ingredient does not match this draft.'); if(active.current) {setConflict(latest); setUnverifiedConflict(null); setError('Review the latest ingredient before continuing.');}})
            .catch(failure => {if(active.current) setError(failure.message);}).finally(() => {saving.current = false; if(active.current) setBusy(false);});
        }}><RotateCw size={17} />Retry latest ingredient</button>}
        {conflict && <section className="conflict-review"><h3>Latest saved ingredient</h3><dl><div><dt>Name / version</dt><dd>{conflict.name} / {conflict.version}</dd></div><div><dt>Physical stock</dt><dd>{conflict.stock_on_hand} {conflict.base_unit}</dd></div><div><dt>Threshold</dt><dd>{conflict.low_stock_threshold ?? 'Not set'}</dd></div></dl>
          <div className="editor-actions"><button type="button" className="button secondary" onClick={() => {if (target.kind === 'purchase') setDraft(old => ({...old,rows:old.rows.map(row => row.ingredient.id === conflict.id ? {...row,ingredient:conflict} : row)})); else setBase(conflict); setConflict(null); setError('');}}>Keep draft with reviewed version</button>
            {target.kind === 'ingredient' && <button type="button" className="button secondary" onClick={() => {setBase(conflict); setDraft(old => ({...old,name:conflict.name,threshold:conflict.low_stock_threshold ?? ''})); setConflict(null); setFields({}); setError('');}}>Replace draft with latest</button>}</div></section>}
        {uncertain && <div className="editor-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => void checkStatus()}><RotateCw size={17} />Check save status</button>{retryAllowed && <button type="button" className="button secondary" disabled={busy} onClick={() => attempt && void send(attempt)}><RotateCw size={17} />Retry original save</button>}</div>}
        <div className="editor-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={locked || Boolean(conflict) || Boolean(unverifiedConflict)}>{review || target.kind === 'ingredient' ? <Save size={17} /> : <Check size={17} />}{busy ? 'Working...' : target.kind === 'ingredient' ? 'Save ingredient' : `${review ? 'Save' : 'Review'} ${target.kind === 'purchase' ? 'purchase' : 'movement'}`}</button></div>
      </form>}
    </Dialog.Content></Dialog.Portal></Dialog.Root></>;
}
