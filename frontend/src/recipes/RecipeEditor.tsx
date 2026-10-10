import * as Dialog from '@radix-ui/react-dialog';
import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Plus, RotateCw, Save, Search, Trash2, X} from 'lucide-react';
import {ApiError, type ApiClient} from '../api/client';
import type {Food, MenuVariant} from '../api/types';
import {Feedback, Field, IconButton} from '../components/ui';
import {scaledQuantity, validQuantity} from '../inventory/model';
import {InventoryPagination, ReadState, useInventoryRecord} from '../inventory/reads';
import {checkedIngredient} from '../inventory/responses';
import type {BaseUnit, PhysicalUnit} from '../inventory/types';
import {sellingLabel} from '../menu/model';
import {checkedPage} from '../menu/responses';
import {NavigationGuard} from '../orders/NavigationGuard';
import {sameItems, sameYield, yieldOf} from './model';
import {checkedRecipe} from './responses';
import type {Recipe, RecipeInput} from './types';

type Row = {id: string; name: string; base: BaseUnit; quantity: string; unit: PhysicalUnit};
const ingredientsPage = (value: unknown) => checkedPage(value, checkedIngredient);
const physicalUnits = (base: BaseUnit): PhysicalUnit[] => base === 'g' ? ['g', 'kg'] : base === 'ml' ? ['ml', 'l'] : ['piece'];
const rowsOf = (recipe: Recipe | null): Row[] => recipe?.items.map(item => ({id: item.ingredient_id, name: item.ingredient_name, base: item.base_unit, quantity: item.quantity, unit: item.unit})) ?? [];
const missingRecipe = (failure: unknown) => {if (failure instanceof ApiError && failure.status === 404) return null; throw failure;};

export function RecipeEditor({client, food, variant, recipe, onClose, onSaved}: {
  client: ApiClient; food: Food; variant: MenuVariant; recipe: Recipe | null; onClose: () => void; onSaved: (recipe: Recipe) => void;
}) {
  const [base, setBase] = useState(recipe), initial = useRef(rowsOf(recipe)), [rows, setRows] = useState(initial.current);
  const [fields, setFields] = useState<Record<string, string>>({}), [error, setError] = useState(''), [busy, setBusy] = useState(false), saving = useRef(false);
  const [discard, setDiscard] = useState(false), [conflict, setConflict] = useState<Recipe | null>(null), [unverified, setUnverified] = useState(false);
  const [uncertain, setUncertain] = useState<RecipeInput | null>(null), [query, setQuery] = useState(''), [page, setPage] = useState(1);
  const active = useRef(true), form = useRef<HTMLFormElement>(null), opener = useRef(document.activeElement as HTMLElement | null);
  const picker = useInventoryRecord(client, 0, `/ingredients?q=${encodeURIComponent(query)}&page=${page}`, ingredientsPage);
  const dirty = JSON.stringify(rows) !== JSON.stringify(initial.current), locked = busy || Boolean(uncertain) || Boolean(conflict) || unverified;
  const selling = yieldOf(variant), path = `/variants/${encodeURIComponent(variant.id)}/recipe`;
  useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
  useEffect(() => {if (!dirty && !uncertain && !busy) return; const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';}; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);}, [dirty, uncertain, busy]);
  useEffect(() => {if (!busy && !discard && Object.keys(fields).length) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();}, [busy, discard, fields]);
  function change(next: Row[]) {setRows(next); setFields({}); setError('');}
  function close() {if (saving.current) return; if (dirty || uncertain) setDiscard(true); else onClose();}
  const saved = (value: Recipe, body: RecipeInput) => value.variant_id === variant.id && value.version === (body.expected_version ?? 0) + 1 && sameYield(value.yield, body.yield) && sameItems(value.items, body.items);
  function review(latest: unknown) {
    try {const checked = checkedRecipe(latest); if (checked.variant_id !== variant.id) throw new Error(); setConflict(checked);}
    catch {setUnverified(true); setError('The latest recipe could not be verified. Keep your draft and reload before saving.');}
  }
  function reject(failure: unknown, body: RecipeInput) {
    const cause = failure instanceof ApiError ? failure : new ApiError(0, 'invalid_response', 'The response could not be verified.', [], true);
    // A version-guarded PUT cannot apply twice, so an unknown outcome is settled by rereading the recipe.
    if (cause.uncertain) {setUncertain(body); setError('Save result unconfirmed. Check the saved recipe before saving again.'); return;}
    setError(cause.message); setFields(Object.fromEntries(cause.fieldErrors.map(item => [item.path, item.message])));
    if (cause.code === 'version_conflict') review(cause.details.latest_resource);
  }
  async function send(body: RecipeInput) {
    if (saving.current) return; saving.current = true; setBusy(true); setError('');
    try {
      const value = checkedRecipe(await client.request(path, {method: 'PUT', body})); if (!active.current) return;
      if (!saved(value, body)) throw new Error('The saved recipe could not be verified.');
      onSaved(value);
    } catch (failure) {if (active.current) reject(failure, body);} finally {saving.current = false; if (active.current) setBusy(false);}
  }
  async function checkSaved() {
    const body = uncertain; if (!body || saving.current) return; saving.current = true; setBusy(true);
    try {
      const latest = await client.request(path).then(checkedRecipe, missingRecipe); if (!active.current) return;
      if (latest && latest.variant_id !== variant.id) throw new Error();
      if (latest ? latest.version === body.expected_version : body.expected_version === null) {setUncertain(null); setError('The recipe was not saved. Review it and save again.');}
      else if (!latest) throw new Error();
      else if (saved(latest, body)) onSaved(latest);
      else {setUncertain(null); setError('The saved recipe differs from this draft. Review the latest recipe.'); review(latest);}
    } catch {if (active.current) setError('The saved recipe could not be checked. Check again.');} finally {saving.current = false; if (active.current) setBusy(false);}
  }
  function submit(event: FormEvent) {
    event.preventDefault(); if (saving.current || locked) return;
    const errors: Record<string, string> = {};
    if (!rows.length) errors['/items'] = 'Add at least one ingredient.';
    rows.forEach((row, i) => {if (!validQuantity(row.quantity, row.unit === 'piece' ? 'piece' : 'g') || scaledQuantity(row.quantity) <= 0n) errors[`/items/${i}/quantity`] = 'Enter a positive quantity with up to three decimal places; pieces are whole counts.';});
    setFields(errors); setError(''); if (Object.keys(errors).length) return;
    void send({expected_version: base?.version ?? null, yield: selling, items: rows.map(row => ({ingredient_id: row.id, quantity: row.quantity, unit: row.unit}))});
  }
  const f = (path: string) => fields[path];
  return <><NavigationGuard dirty={dirty || Boolean(uncertain)} busy={busy} onLeave={onClose} label="recipe" />
    <Dialog.Root open onOpenChange={open => {if (!open) close();}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="editor-dialog order-editor" aria-describedby={undefined}
      onOpenAutoFocus={event => {event.preventDefault(); form.current?.querySelector<HTMLInputElement>('input')?.focus();}} onCloseAutoFocus={event => {event.preventDefault(); if (opener.current?.isConnected) opener.current.focus();}}>
      <div className="editor-heading"><div><Dialog.Title>{discard ? 'Discard changes?' : base ? 'Edit recipe' : 'Add recipe'}</Dialog.Title><small>{`${food.name} / ${variant.label}`}</small></div><IconButton label="Close recipe editor" disabled={busy} onClick={close}><X size={20} /></IconButton></div>
      {discard ? <><p className="discard-copy">{uncertain ? 'This save is still unresolved. Closing discards these entries; reopen the recipe to see what was saved.' : 'Your unsaved changes will be lost.'}</p><div className="editor-actions">
        <button className="button secondary" onClick={() => setDiscard(false)}>Keep editing</button><button className="button danger" onClick={onClose}>Discard changes</button></div></> : <form ref={form} onSubmit={submit} noValidate aria-busy={busy}>
        <p className="estimate-note">{`Enter quantities for exactly ${sellingLabel(selling.selling_unit, selling.package_contents)}. Each selling size needs its own recipe.`}</p>
        <fieldset className="order-entry-fields" disabled={locked}><section className="entry-section"><h3>Ingredients</h3>
          <Field id="find-ingredient" label="Find ingredient" value={query} maxLength={200} onChange={event => {setQuery(event.target.value); setPage(1);}} suffix={<Search size={18} className="search-icon" />} />
          {!picker.value ? <ReadState error={picker.error} retry={picker.retry} loading="Loading ingredient choices..." /> : <><div className="ingredient-picker">{picker.value.items.map(item => <button type="button" className="button secondary" key={item.id}
            disabled={rows.length >= 100 || rows.some(row => row.id === item.id)} onClick={() => change([...rows, {id: item.id, name: item.name, base: item.base_unit, quantity: '', unit: item.base_unit}])}><Plus size={16} />Add {item.name}</button>)}</div>
            {!picker.value.items.length && <p>No ingredients match.</p>}<InventoryPagination value={picker.value} label="ingredient choices" change={setPage} /></>}
          {f('/items') && <Feedback error>{f('/items')}</Feedback>}
          {rows.map((row, i) => <section className="draft-line" key={row.id}><div className="draft-line-heading"><div><strong>{row.name}</strong><small>Base unit: {row.base}</small></div>
            <IconButton label={`Remove ${row.name}`} onClick={() => change(rows.filter(item => item.id !== row.id))}><Trash2 size={18} /></IconButton></div>
            {f(`/items/${i}/ingredient_id`) && <Feedback error>{f(`/items/${i}/ingredient_id`)}</Feedback>}
            <div className="entry-grid"><Field id={`recipe-quantity-${i}`} label={`Quantity of ${row.name}`} inputMode="decimal" value={row.quantity} error={f(`/items/${i}/quantity`)}
              onChange={event => change(rows.map(item => item.id === row.id ? {...item, quantity: event.target.value} : item))} />
              <div className="field"><label htmlFor={`recipe-unit-${i}`}>{`Unit for ${row.name}`}</label><select id={`recipe-unit-${i}`} value={row.unit} aria-invalid={Boolean(f(`/items/${i}/unit`))} aria-describedby={f(`/items/${i}/unit`) ? `recipe-unit-${i}-error` : undefined}
                onChange={event => change(rows.map(item => item.id === row.id ? {...item, unit: event.target.value as PhysicalUnit} : item))}>{physicalUnits(row.base).map(unit => <option key={unit} value={unit}>{unit}</option>)}</select>
                {f(`/items/${i}/unit`) && <p className="field-error" id={`recipe-unit-${i}-error`}>{f(`/items/${i}/unit`)}</p>}</div></div></section>)}
        </section></fieldset>
        {(f('/yield') ?? f('/expected_version')) && <Feedback error>{f('/yield') ?? f('/expected_version')}</Feedback>}
        {error && <Feedback error>{error}</Feedback>}
        {conflict && <section className="conflict-review"><h3>Latest saved recipe</h3><p>{`Version ${conflict.version}, for ${sellingLabel(conflict.yield.selling_unit, conflict.yield.package_contents)}`}</p>
          <dl>{conflict.items.map(item => <div key={item.ingredient_id}><dt>{item.ingredient_name}</dt><dd>{`${item.quantity} ${item.unit}`}</dd></div>)}</dl>
          <div className="editor-actions"><button type="button" className="button secondary" onClick={() => {setBase(conflict); setConflict(null); setError('');}}>Keep draft with reviewed version</button>
            <button type="button" className="button secondary" onClick={() => {const next = rowsOf(conflict); initial.current = next; setRows(next); setBase(conflict); setConflict(null); setFields({}); setError('');}}>Replace draft with latest</button></div></section>}
        {uncertain && <div className="editor-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => void checkSaved()}><RotateCw size={17} />Check saved recipe</button></div>}
        <div className="editor-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button>
          <button type="submit" className="button primary" disabled={locked}><Save size={17} />{busy ? 'Saving...' : 'Save recipe'}</button></div>
      </form>}
    </Dialog.Content></Dialog.Portal></Dialog.Root></>;
}
