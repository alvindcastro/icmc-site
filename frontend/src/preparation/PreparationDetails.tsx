import {useCallback, useEffect, useRef, useState} from 'react';
import {Link, useLocation, useParams} from 'react-router-dom';
import {ChevronLeft, ClipboardCheck, PencilLine, Trash2} from 'lucide-react';
import {Feedback} from '../components/ui';
import {useInventory} from '../inventory/InventoryArea';
import {ReadState, useInventoryRecord} from '../inventory/reads';
import {checkedIngredient} from '../inventory/responses';
import {formatBusinessTime, formatCalendarDate, formatMoney} from '../lib/format';
import {sellingLabel} from '../menu/model';
import {correctionOperationMarker, preparationEnabled, signedQuantity} from './model';
import {checkedCorrections, checkedPreparation} from './responses';
import type {Preparation} from './types';

export function PreparationDetails() {
  const {client, settings, revision, blocked, open} = useInventory(), {id = ''} = useParams(), origin = useLocation().state as {recorded?: boolean; corrected?: boolean; returnTo?: string} | null;
  const validate = useCallback((value: unknown) => {const result = checkedPreparation(value); if (result.id !== id) throw new Error('Preparation record does not match this address.'); return result;}, [id]);
  const state = useInventoryRecord(client, revision, `/preparations/${encodeURIComponent(id)}`, validate), item = state.value;
  const listed = useCallback((value: unknown) => checkedCorrections(value, id), [id]), corrections = useInventoryRecord(client, revision, item ? `/preparations/${encodeURIComponent(id)}/corrections` : null, listed);
  const correcting = `/preparations/${encodeURIComponent(id)}/correct`;
  const [opening, setOpening] = useState(false), [failure, setFailure] = useState(''), active = useRef(true);
  useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
  // Returned, wasted or miscounted stock is a new movement on the ingredient, read at its current version and linked back here.
  async function adjust(row: Preparation['consumption'][number], action: 'waste' | 'correction') {
    if (opening) return; setOpening(true); setFailure('');
    try {
      const ingredient = checkedIngredient(await client.request(`/ingredients/${encodeURIComponent(row.ingredient_id)}`)); if (!active.current) return;
      if (!ingredient.permitted_actions[action].allowed) throw new Error(ingredient.permitted_actions[action].reason ?? 'This stock movement is not available.');
      open({kind: 'movement', ingredient, action, link: {preparation_id: id, movement_id: row.stock_movement_id}});
    } catch (error) {if (active.current) setFailure((error as Error).message);} finally {if (active.current) setOpening(false);}
  }
  const back = typeof origin?.returnTo === 'string' && /^\/planning(\?|$)/.test(origin.returnTo) ? origin.returnTo : '/planning';
  return <><div className="page-heading"><div><span className="eyebrow">STOCK DEDUCTION</span><h1>Preparation record</h1></div><div className="heading-actions">{preparationEnabled(settings) && item && <Link className="button secondary" to={correcting}><PencilLine size={17} />Correct prepared counts</Link>}
      <Link className="button secondary" to={back}><ChevronLeft size={17} />Back to planning</Link></div></div>
    {origin?.recorded && <div className="menu-notice"><Feedback>Preparation recorded.</Feedback></div>}
    {origin?.corrected && <div className="menu-notice"><Feedback>Correction recorded.</Feedback></div>}
    {sessionStorage.getItem(correctionOperationMarker) && <div className="menu-notice"><Feedback>An earlier correction save is unresolved.<Link className="text-action" to={correcting}>Check it before correcting more</Link></Feedback></div>}
    {!item ? <ReadState error={state.error} retry={state.retry} loading="Loading preparation record..." /> : <>
      <dl className="order-facts"><div><dt>Prepared on</dt><dd>{formatCalendarDate(item.prepared_on)}</dd></div>
        <div><dt>Recorded</dt><dd>{`${formatBusinessTime(item.recorded_at, settings.timezone)} by ${item.recorded_by}`}</dd></div>
        <div><dt>Estimated ingredient cost</dt><dd>{item.estimate_complete ? formatMoney(item.estimated_ingredient_cost_minor!, item) : 'Unknown'}</dd></div></dl>
      <section className="page-section" aria-labelledby="record-food-heading"><h2 id="record-food-heading">Food prepared</h2>
        <table className="ledger-table"><thead><tr><th>Food / variant</th><th>Order</th><th>Prepared</th></tr></thead><tbody>{item.allocations.map(row => {
          const recipe = item.recipe_snapshots.find(snapshot => snapshot.variant_id === row.variant_id);
          return <tr key={row.order_item_id}><th scope="row">{row.food_name}<small>{`${row.variant_label} / ${sellingLabel(row.selling_unit, row.package_contents)}`}</small><small>{recipe?.recipe_version ? `Recipe version ${recipe.recipe_version}` : 'No recipe recorded'}</small></th>
            <td data-label="Order"><Link to={`/orders/${encodeURIComponent(row.order_id)}`}>{row.reference}</Link></td><td data-label="Prepared">{row.quantity}</td></tr>;
        })}</tbody></table>
      </section>
      <section className="page-section" aria-labelledby="record-used-heading"><h2 id="record-used-heading">Ingredients used</h2>
        {!item.consumption.length ? <p className="empty-state">No tracked ingredients were used.</p> : <table className="ledger-table"><thead><tr><th>Ingredient</th><th>Used</th><th>Physical stock</th><th>Later changes</th></tr></thead><tbody>{item.consumption.map(row => <tr key={row.ingredient_id}>
          <th scope="row"><Link to={`/ingredients/${encodeURIComponent(row.ingredient_id)}?movement_id=${encodeURIComponent(row.stock_movement_id)}#movement-${row.stock_movement_id}`}>{row.ingredient_name}</Link></th>
          <td data-label="Used"><span>{`${row.quantity} ${row.unit}`}</span>{row.unit !== row.base_unit && <small>{`${row.base_quantity} ${row.base_unit}`}</small>}</td>
          <td data-label="Physical stock">{`${row.before_quantity} ${row.base_unit} -> ${row.after_quantity} ${row.base_unit}`}</td>
          <td data-label="Later changes"><div className="record-corrections"><button className="button secondary" disabled={blocked || opening} aria-label={`Correct stock for ${row.ingredient_name}`} onClick={() => void adjust(row, 'correction')}><ClipboardCheck size={17} />Correct stock</button>
            <button className="button secondary" disabled={blocked || opening} aria-label={`Record waste for ${row.ingredient_name}`} onClick={() => void adjust(row, 'waste')}><Trash2 size={17} />Record waste</button></div></td></tr>)}</tbody></table>}
        {failure && <Feedback error>{failure}</Feedback>}
        {item.note && <p className="order-notes">{item.note}</p>}
        <p className="estimate-note">Stock used here stays used when an order is edited or cancelled. Record returned, miscounted or wasted ingredients as a separate stock movement; this record does not change.</p>
      </section>
      {corrections.error && <ReadState error={corrections.error} retry={corrections.retry} loading="" />}
      {corrections.value && corrections.value.length > 0 && <section className="page-section" aria-labelledby="record-corrections-heading"><h2 id="record-corrections-heading">Corrections</h2>
        {corrections.value.map(entry => <article className="draft-line" key={entry.id}><div className="draft-line-heading"><div><strong>{entry.reason}</strong><small>{`${formatBusinessTime(entry.recorded_at, settings.timezone)} by ${entry.recorded_by}`}</small></div></div>
          <ul className="prepared-review">{entry.allocations.map(row => <li key={row.order_item_id}><Link to={`/orders/${encodeURIComponent(row.order_id)}`}>{row.reference}</Link>{` ${row.variant_label} of ${row.food_name}: `}<span>{`${row.prepared_before} -> ${row.prepared_after} of ${row.ordered_quantity}`}</span></li>)}
            {entry.stock_corrections.map(row => <li key={row.ingredient_id}><Link to={`/ingredients/${encodeURIComponent(row.ingredient_id)}?movement_id=${encodeURIComponent(row.stock_movement_id)}#movement-${row.stock_movement_id}`}>{row.ingredient_name}</Link>{`: ${signedQuantity(row.delta_base_quantity)} ${row.base_unit}, `}<span>{`${row.before_quantity} ${row.base_unit} -> ${row.after_quantity} ${row.base_unit}`}</span></li>)}</ul></article>)}
      </section>}
    </>}
  </>;
}
