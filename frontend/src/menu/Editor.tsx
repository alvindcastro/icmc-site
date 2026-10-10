import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Save, X, RotateCw } from 'lucide-react';
import { ApiError, type ApiClient } from '../api/client';
import { holdAttempt, releaseAttempt } from '../api/pending';
import type { BusinessSettings, Category, Food, MenuVariant, MenuOperation, SellingUnit } from '../api/types';
import { Feedback, Field, IconButton } from '../components/ui';
import { formatMoney } from '../lib/format';
import { parsePrice, priceInput, sellingLabel } from './model';
import { checkedFood, checkedOperation, checkedVariant } from './responses';

export const menuOperationMarker = 'food-reservations:menu-operation';
export type EditorTarget = {kind: 'food'; food?: Food} | {kind: 'variant'; food: Food; variant?: MenuVariant};
type Draft = {name: string; category_id: string; description: string; available: boolean; label: string; selling_unit: SellingUnit; price: string; pieces: string};
function draftFor(target: EditorTarget, digits: number): Draft {
  const food = target.food;
  const variant = target.kind === 'variant' ? target.variant : undefined;
  return {name: food?.name ?? '', category_id: food?.category_id ?? '', description: food?.description ?? '',
    available: target.kind === 'food' ? food?.available ?? true : variant?.available ?? true,
    label: variant?.label ?? '', selling_unit: variant?.selling_unit ?? 'tray',
    price: variant ? priceInput(variant.price_minor, digits) : '', pieces: variant?.package_contents?.quantity.toString() ?? ''};
}

export function MenuEditor({target, client, settings, categories, onClose, onSaved}: {
  target: EditorTarget; client: ApiClient; settings: BusinessSettings; categories: Category[]; onClose: () => void; onSaved: (message: string) => void;
}) {
  const isFood = target.kind === 'food';
  const initial = useRef(draftFor(target, settings.minor_digits));
  const [draft, setDraft] = useState(initial.current);
  const [base, setBase] = useState<Food | MenuVariant | undefined>(isFood ? target.food : target.variant);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [discard, setDiscard] = useState(false);
  const [conflict, setConflict] = useState<Food | MenuVariant | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [attempt, setAttempt] = useState<{id: string; path: string; method: string; body: unknown} | null>(null);
  const [retryAllowed, setRetryAllowed] = useState(false);
  const active = useRef(true);
  const form = useRef<HTMLFormElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial.current);
  const title = `${base ? 'Edit' : 'Add'} ${isFood ? 'food' : 'variant'}`;
  const permission = base?.permitted_actions.edit;
  useEffect(() => () => {active.current = false;}, []);
  useEffect(() => {
    if (!dirty && !uncertain && !busy) return;
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';};
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, uncertain, busy]);
  useEffect(() => {
    if (!busy && !discard && Object.keys(fields).length) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [busy, fields, discard]);
  function close() {
    if (saving.current) return;
    if (dirty || uncertain) setDiscard(true); else onClose();
  }
  function change(key: keyof Draft, value: string | boolean) {setDraft(previous => ({...previous, [key]: value}));}
  function reject(failure: ApiError) {
    if (failure.uncertain || ['operation_in_progress', 'operation_payload_mismatch'].includes(failure.code)) {
      setUncertain(true); setError('Save result unconfirmed. Check its status before another submission.'); return;
    }
    releaseAttempt(menuOperationMarker); setAttempt(null); setUncertain(false); setRetryAllowed(false);
    setError(failure.message);
    const nextFields: Record<string, string> = {};
    failure.fieldErrors.forEach(field => {nextFields[field.path] = field.message;});
    setFields(nextFields);
    if (failure.code === 'version_conflict' && failure.details.latest_resource) {
      try {setConflict(isFood ? checkedFood(failure.details.latest_resource) : checkedVariant(failure.details.latest_resource));}
      catch {setError('The latest record could not be verified. Keep your draft and reload the menu before saving.');}
    }
  }
  async function send(next: NonNullable<typeof attempt>) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(null); setRetryAllowed(false);
    setAttempt(next); holdAttempt(menuOperationMarker, next);
    try {
      const result = await client.request<Food | MenuVariant>(next.path, {method: next.method, body: next.body, operationId: next.id});
      if (!active.current) return;
      try {
        if (isFood) checkedFood(result); else checkedVariant(result);
        if (base && result.id !== base.id || !isFood && (result as MenuVariant).food_id !== target.food.id) throw new Error();
      } catch {throw new ApiError(200, 'invalid_response', 'The saved record could not be verified.', [], true);}
      releaseAttempt(menuOperationMarker);
      onSaved(isFood ? 'Food saved.' : 'Variant saved.');
    } catch (failure) {if (active.current) reject(failure as ApiError);}
    finally {saving.current = false; if (active.current) setBusy(false);}
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || uncertain || conflict || permission?.allowed === false) return;
    const invalid: Record<string, string> = {};
    const price = parsePrice(draft.price, settings.minor_digits);
    const pieces = /^\d+$/.test(draft.pieces) ? Number(draft.pieces) : NaN;
    if (isFood) {
      if (!draft.name.trim()) invalid['/name'] = 'Enter a food name.';
      if (!draft.category_id) invalid['/category_id'] = 'Choose a category.';
    } else {
      if (!draft.label.trim()) invalid['/label'] = 'Enter a variant label.';
      if (price === null) invalid['/price_minor'] = `Enter a nonnegative price with up to ${settings.minor_digits} decimal places.`;
      if (draft.selling_unit === 'package' && (!Number.isSafeInteger(pieces) || pieces < 1)) invalid['/package_contents/quantity'] = 'Enter a positive whole piece count.';
    }
    setFields(invalid); setError(null);
    if (Object.keys(invalid).length) return;
    const body = isFood ? {name: draft.name.trim(), category_id: draft.category_id, description: draft.description, available: draft.available}
      : {label: draft.label.trim(), selling_unit: draft.selling_unit, price_minor: price!, available: draft.available,
        package_contents: draft.selling_unit === 'package' ? {quantity: pieces, unit: 'piece'} : null};
    const path = isFood ? base ? `/foods/${encodeURIComponent(base.id)}` : '/foods'
      : base ? `/variants/${encodeURIComponent(base.id)}` : `/foods/${encodeURIComponent(target.food!.id)}/variants`;
    void send({id: crypto.randomUUID(), path, method: base ? 'PATCH' : 'POST', body: {...body, ...(base ? {expected_version: base.version} : {})}});
  }
  async function checkStatus() {
    if (!attempt || saving.current) return;
    saving.current = true; setBusy(true); setRetryAllowed(false);
    try {
      const result = checkedOperation(await client.request<MenuOperation>(`/operations/${encodeURIComponent(attempt.id)}`), attempt.id);
      if (!active.current) return;
      if (result.operation_id !== attempt.id) throw new Error('The server returned an invalid save status.');
      if (result.state === 'succeeded' && result.result?.body?.id) {
        releaseAttempt(menuOperationMarker); onSaved(isFood ? 'Food saved.' : 'Variant saved.');
      } else if (result.state === 'rejected' && result.error) {
        const failure = result.error;
        reject(new ApiError(failure.http_status, failure.error.code, failure.error.message, failure.error.field_errors, false, failure.error.details));
      } else if (result.state === 'processing') setError('The save is still processing. Check its status again.');
      else throw new Error('The server returned an invalid save status.');
    } catch (failure) {
      if (!active.current) return;
      if (failure instanceof ApiError && failure.status === 404) {
        setRetryAllowed(true); setError('No result yet. Only the exact original submission can be retried.');
      } else setError((failure as Error).message);
    } finally {saving.current = false; if (active.current) setBusy(false);}
  }
  const locked = busy || uncertain || permission?.allowed === false;
  const fieldError = (path: string) => fields[path];
  return <Dialog.Root open onOpenChange={open => {if (!open) close();}}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="editor-dialog" aria-describedby={undefined}
      onOpenAutoFocus={event => {event.preventDefault(); form.current?.querySelector<HTMLInputElement>('input')?.focus();}}
      onCloseAutoFocus={event => {event.preventDefault();}}>
      <div className="editor-heading"><div><Dialog.Title>{discard ? 'Discard changes?' : title}</Dialog.Title>
        {!isFood && <small>{target.food.name}</small>}</div><IconButton label="Close editor" disabled={busy} onClick={close}><X size={20} /></IconButton></div>
      {discard ? <><p className="discard-copy">{uncertain ? 'This save is still unresolved. Closing discards these entries; check or retry the save from the menu.' : 'Your unsaved changes will be lost.'}</p><div className="editor-actions">
        <button className="button secondary" onClick={() => setDiscard(false)}>Keep editing</button>
        <button className="button danger" onClick={onClose}>Discard changes</button></div></> :
        <form ref={form} onSubmit={submit} noValidate aria-busy={busy}>
          <div className="editor-fields">
            {isFood ? <>
              <Field id="food-name" label="Food name" maxLength={200} value={draft.name} onChange={event => change('name', event.target.value)} disabled={locked} error={fieldError('/name')} />
              <div className="field"><label htmlFor="food-category">Food category</label><select id="food-category" value={draft.category_id} disabled={locked}
                onChange={event => change('category_id', event.target.value)} aria-invalid={Boolean(fieldError('/category_id'))} aria-describedby={fieldError('/category_id') ? 'food-category-error' : undefined}>
                <option value="">Choose category</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
                {fieldError('/category_id') && <p className="field-error" id="food-category-error">{fieldError('/category_id')}</p>}</div>
              <div className="field"><label htmlFor="food-description">Description</label><textarea id="food-description" value={draft.description} maxLength={2000} disabled={locked}
                onChange={event => change('description', event.target.value)} aria-invalid={Boolean(fieldError('/description'))} aria-describedby={fieldError('/description') ? 'description-error' : undefined} />
                {fieldError('/description') && <p className="field-error" id="description-error">{fieldError('/description')}</p>}</div>
            </> : <>
              <Field id="variant-label" label="Variant label" maxLength={200} value={draft.label} onChange={event => change('label', event.target.value)} disabled={locked} error={fieldError('/label')} />
              <div className="field"><label htmlFor="selling-unit">Selling unit</label><select id="selling-unit" value={draft.selling_unit} disabled={locked}
                onChange={event => change('selling_unit', event.target.value)} aria-invalid={Boolean(fieldError('/selling_unit'))} aria-describedby={fieldError('/selling_unit') ? 'unit-error' : undefined}>
                <option value="tray">Tray</option><option value="piece">Piece</option><option value="stick">Stick</option><option value="package">Fixed-size package</option></select>
                {fieldError('/selling_unit') && <p className="field-error" id="unit-error">{fieldError('/selling_unit')}</p>}</div>
              <Field id="variant-price" label={`Price (${settings.currency})`} inputMode="decimal" value={draft.price} onChange={event => change('price', event.target.value)} disabled={locked} error={fieldError('/price_minor')} />
              {draft.selling_unit === 'package' && <Field id="package-pieces" label="Pieces per package" inputMode="numeric" value={draft.pieces} onChange={event => change('pieces', event.target.value)} disabled={locked}
                error={fieldError('/package_contents/quantity') ?? fieldError('/package_contents')} />}
            </>}
            <label className="checkbox-field"><input type="checkbox" checked={draft.available} disabled={locked} onChange={event => change('available', event.target.checked)} />{isFood ? 'Food available' : 'Variant available'}</label>
          </div>
          {permission?.allowed === false && <Feedback error>{permission.reason ?? 'Editing is not permitted.'}</Feedback>}
          {error && <Feedback error>{error}</Feedback>}
          {conflict && <section className="conflict-review"><h3>Latest saved record</h3>
            <dl><div><dt>{isFood ? 'Name' : 'Label'}</dt><dd>{'name' in conflict ? conflict.name : conflict.label}</dd></div>
              {'name' in conflict ? <><div><dt>Category</dt><dd>{categories.find(item => item.id === conflict.category_id)?.name ?? conflict.category_id}</dd></div>
                <div><dt>Description</dt><dd>{conflict.description || 'None'}</dd></div></> : <><div><dt>Price</dt><dd>{formatMoney(conflict.price_minor, settings)}</dd></div>
                <div><dt>Selling unit</dt><dd>{sellingLabel(conflict.selling_unit, conflict.package_contents)}</dd></div></>}
              <div><dt>Availability</dt><dd>{conflict.available ? 'Available' : 'Unavailable'}</dd></div></dl>
            <div className="editor-actions"><button type="button" className="button secondary" onClick={() => {setBase(conflict); setConflict(null); setError(null);}}>Keep draft with reviewed version</button>
              <button type="button" className="button secondary" onClick={() => {
                const replacement: EditorTarget = 'name' in conflict ? {kind: 'food', food: conflict} : {kind: 'variant', food: target.food!, variant: conflict};
                const values = draftFor(replacement, settings.minor_digits); initial.current = values; setDraft(values); setBase(conflict); setConflict(null); setError(null); setFields({});
              }}>Replace draft with latest</button></div></section>}
          {uncertain && <div className="editor-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => void checkStatus()}><RotateCw size={17} />Check save status</button>
            {retryAllowed && <button type="button" className="button secondary" disabled={busy} onClick={() => attempt && void send(attempt)}><RotateCw size={17} />Retry original save</button>}</div>}
          <div className="editor-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button>
            <button type="submit" className="button primary" disabled={locked || Boolean(conflict)}><Save size={17} />{busy ? 'Saving...' : isFood ? 'Save food' : 'Save variant'}</button></div>
        </form>}
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
