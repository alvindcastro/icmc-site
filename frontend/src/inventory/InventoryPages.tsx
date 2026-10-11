import {useCallback, useEffect, useRef, useState} from 'react';
import {Link, useLocation, useParams, useSearchParams} from 'react-router-dom';
import {ArrowLeft, ListFilter, Plus, Search, Pencil, PackagePlus, Trash2, ClipboardCheck} from 'lucide-react';
import type {ApiClient} from '../api/client';
import type {BusinessSettings, PageResult} from '../api/types';
import {protectedData} from '../auth/protected-data';
import {Field, IconButton, Feedback, Loading} from '../components/ui';
import {formatMoney, formatCalendarDate, formatBusinessTime} from '../lib/format';
import {checkedPage} from '../menu/responses';
import {useInventory} from './InventoryArea';
import {checkedIngredient, checkedMovement, checkedPrice, checkedPurchase, checkedPurchaseSummary} from './responses';
import {comparableCost} from './model';
import {InventoryPagination, ReadState, useInventoryRecord} from './reads';
import type {Ingredient, Movement, Price, Purchase} from './types';
export const ingredientPage = (value: unknown) => checkedPage(value, checkedIngredient);
const purchasePage = (value: unknown) => checkedPage(value, checkedPurchaseSummary);
const movementPage = (value: unknown) => checkedPage(value, checkedMovement);
const pricePage = (value: unknown) => checkedPage(value, checkedPrice);
function useFilters() {
  const [params, setParams] = useSearchParams();
  function filter(key: string, value: string) {const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); if (key !== 'page') next.delete('page'); setParams(next, {replace: key !== 'page'});}
  return {params, filter, clear: () => setParams({}, {replace: true})};
}
function useListScroll(ready: boolean) {
  const location = useLocation(), route = location.pathname + location.search, restored = useRef('');
  useEffect(() => {if (ready && restored.current !== route) {const scroll = protectedData.get(`inventory-scroll:${route}`); if (typeof scroll === 'number') window.scrollTo(0, scroll); restored.current = route;}}, [route, ready]); return route;
}
function InventoryLink({to, name, route}: {to: string; name: string; route: string}) {
  return <Link to={to} state={{returnTo: route}} onClick={() => protectedData.set(`inventory-scroll:${route}`, window.scrollY)}>{name}</Link>;
}
export function IngredientsPage() {
  const {client, settings, revision, blocked, open} = useInventory(), {params, filter, clear} = useFilters();
  const state = useInventoryRecord(client, revision, `/ingredients?${params}`, ingredientPage), route = useListScroll(Boolean(state.value));
  return <><div className="page-heading"><h1>Ingredients</h1><button className="button primary" disabled={blocked} onClick={() => open({kind: 'ingredient'})}><Plus size={18} />Add ingredient</button></div>
    <div className="menu-filters"><Field id="ingredient-search" label="Search ingredients" maxLength={200} value={params.get('q') ?? ''} onChange={e => filter('q', e.target.value)} suffix={<Search size={18} className="search-icon" />} />
      <label className="checkbox-field"><input type="checkbox" checked={params.get('low_stock') === 'true'} onChange={e => filter('low_stock', e.target.checked ? 'true' : '')} />Low stock only</label><IconButton label="Clear inventory filters" onClick={clear}><ListFilter size={20} /></IconButton></div>
    {!state.value ? <ReadState error={state.error} retry={state.retry} loading="Loading ingredients..." /> : <><div className="menu-count">{state.value.total} ingredients</div>
      {state.value.items.length ? <IngredientTable items={state.value.items} settings={settings} route={route} /> : <p className="empty-state">{params.has('q') || params.has('low_stock') ? 'No ingredients match these filters.' : 'No ingredients yet.'}</p>}
      <InventoryPagination value={state.value} label="ingredients" change={page => filter('page', String(page))} /></>}
  </>;
}
function IngredientTable({items, settings, route}: {items: Ingredient[]; settings: BusinessSettings; route: string}) {
  return <table className="order-table"><thead><tr><th>Ingredient</th><th>Physical stock / threshold</th><th>Latest unit cost</th><th>Last purchase</th></tr></thead><tbody>{items.map(item => <tr key={item.id}>
    <th scope="row"><InventoryLink to={`/ingredients/${encodeURIComponent(item.id)}`} name={item.name} route={route} /><small>Base unit: {item.base_unit}</small></th>
    <td data-label="Physical stock">{item.stock_on_hand} {item.base_unit}<small>Threshold: {item.low_stock_threshold === null ? 'Not set' : `${item.low_stock_threshold} ${item.base_unit}`}</small>{item.low_stock && <span className="status-label status-partial">Low stock</span>}</td>
    <td data-label="Latest unit cost">{comparableCost(item.latest_unit_cost, item.base_unit, settings.currency)}</td><td data-label="Last purchase">{item.latest_purchase_date ? formatCalendarDate(item.latest_purchase_date) : 'No purchases'}</td>
  </tr>)}</tbody></table>;
}
export function PurchasesPage() {
  const {client, revision, blocked, open} = useInventory(), {params, filter, clear} = useFilters();
  const state = useInventoryRecord(client, revision, `/purchases?${params}`, purchasePage), route = useListScroll(Boolean(state.value));
  return <><div className="page-heading"><h1>Purchases</h1><button className="button primary" disabled={blocked} onClick={() => open({kind: 'purchase'})}><Plus size={18} />Record purchase</button></div>
    <div className="menu-filters order-filters"><Field id="purchase-search" label="Search purchases" maxLength={200} value={params.get('q') ?? ''} onChange={e => filter('q', e.target.value)} suffix={<Search size={18} className="search-icon" />} />
      <Field id="supplier-filter" label="Supplier filter" maxLength={200} value={params.get('supplier') ?? ''} onChange={e => filter('supplier', e.target.value)} />
      <Field id="purchase-from" label="From date" type="date" value={params.get('date_from') ?? ''} onChange={e => filter('date_from', e.target.value)} /><Field id="purchase-to" label="To date" type="date" value={params.get('date_to') ?? ''} onChange={e => filter('date_to', e.target.value)} />
      <IconButton label="Clear inventory filters" onClick={clear}><ListFilter size={20} /></IconButton></div>
    {!state.value ? <ReadState error={state.error} retry={state.retry} loading="Loading purchases..." /> : <><div className="menu-count">{state.value.total} purchases</div>
      {state.value.items.length ? <table className="order-table"><thead><tr><th>Receipt</th><th>Supplier</th><th>Purchased on</th><th>Total ingredient cost</th></tr></thead><tbody>{state.value.items.map(item => <tr key={item.id}>
        <th scope="row"><InventoryLink to={`/purchases/${encodeURIComponent(item.id)}`} name={item.reference} route={route} /></th><td data-label="Supplier">{item.supplier}</td><td data-label="Purchased on">{formatCalendarDate(item.purchased_on)}</td><td data-label="Total cost">{formatMoney(item.total_cost_minor, item)}</td>
      </tr>)}</tbody></table> : <p className="empty-state">{['q','supplier','date_from','date_to'].some(key => params.has(key)) ? 'No purchases match these filters.' : 'No purchases yet.'}</p>}
      <InventoryPagination value={state.value} label="purchases" change={page => filter('page', String(page))} /></>}
  </>;
}
function Back({fallback}: {fallback: 'ingredients' | 'purchases'}) {
  const requested = useLocation().state?.returnTo;
  const to = typeof requested === 'string' && /^\/(ingredients|purchases|dashboard)(\?|$)/.test(requested) && !/[\\\r\n]/.test(requested) ? requested : `/${fallback}`;
  return <Link className="back-link" to={to}><ArrowLeft size={16} />Back to {to.startsWith('/dashboard') ? 'dashboard' : fallback}</Link>;
}
export function IngredientDetails() {
  const {id = ''} = useParams(), {client, revision, settings, open, blocked} = useInventory();
  const validate = useCallback((value: unknown) => {const item = checkedIngredient(value); if (item.id !== id) throw new Error('Ingredient does not match this page.'); return item;}, [id]);
  const state = useInventoryRecord(client, revision, `/ingredients/${encodeURIComponent(id)}`, validate);
  return <><Back fallback="ingredients" />{!state.value ? <ReadState error={state.error} retry={state.retry} loading="Loading ingredient..." /> : <>
    <div className="page-heading order-detail-heading"><div><h1>{state.value.name}</h1><small>Version {state.value.version}</small></div><div className="order-actions">
      <button className="button secondary" disabled={blocked || !state.value.permitted_actions.edit.allowed} title={state.value.permitted_actions.edit.reason ?? undefined} onClick={() => open({kind: 'ingredient', ingredient: state.value})}><Pencil size={17} />Edit ingredient</button>
      {(['opening','waste','correction'] as const).map(action => <div className="order-command" key={action}><button className="button secondary" disabled={blocked || !state.value!.permitted_actions[action].allowed} onClick={() => open({kind: 'movement', ingredient: state.value!, action})}>
        {action === 'opening' ? <PackagePlus size={17} /> : action === 'waste' ? <Trash2 size={17} /> : <ClipboardCheck size={17} />}{action === 'opening' ? 'Opening stock' : action === 'waste' ? 'Record waste' : 'Correct stock'}</button>{!state.value!.permitted_actions[action].allowed && <small>{state.value!.permitted_actions[action].reason}</small>}</div>)}
    </div></div>
    <dl className="order-facts page-section"><div><dt>Physical stock</dt><dd>{state.value.stock_on_hand} {state.value.base_unit}{state.value.low_stock && <small className="stock-warning">Low stock</small>}</dd></div><div><dt>Low-stock threshold</dt><dd>{state.value.low_stock_threshold === null ? 'Not set' : `${state.value.low_stock_threshold} ${state.value.base_unit}`}</dd></div>
      <div><dt>Latest unit cost</dt><dd>{comparableCost(state.value.latest_unit_cost, state.value.base_unit, settings.currency)}</dd></div><div><dt>Latest purchase</dt><dd>{state.value.latest_purchase_date ? formatCalendarDate(state.value.latest_purchase_date) : 'No purchases'}</dd></div></dl>
    <MovementHistory ingredient={state.value} /><PriceHistory ingredient={state.value} />
  </>}</>;
}
function MovementHistory({ingredient}: {ingredient: Ingredient}) {
  const {client, revision, settings} = useInventory(), [params, setParams] = useSearchParams();
  const requested = params.get('movement_id'), [located, setLocated] = useState<{id: string; page?: number; error?: string} | null>(null), [locateRetry, setLocateRetry] = useState(0);
  useEffect(() => {
    if (!requested) {setLocated(null); return;}
    let active = true; const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000); setLocated({id: requested});
    void (async () => {
      for (let page = 1; ; page++) {
        const result = movementPage(await client.request(`/ingredients/${encodeURIComponent(ingredient.id)}/movements?page=${page}`, {signal: controller.signal})); controller.signal.throwIfAborted();
        if (result.page !== page || result.items.some(row => row.ingredient_id !== ingredient.id)) throw new Error('Movement history does not match this ingredient.');
        if (result.items.some(row => row.id === requested)) {if (active) setLocated({id: requested, page}); return;}
        if (!result.has_next) throw new Error('Linked stock movement was not found.');
      }
    })().catch(error => {if (active) setLocated({id: requested, error: error.message});}).finally(() => clearTimeout(timeout));
    return () => {active = false; clearTimeout(timeout); controller.abort();};
  }, [requested, ingredient.id, client, revision, locateRetry]);
  const page = requested && located?.id === requested && located.page ? String(located.page) : params.get('movement_page') ?? '1';
  const validate = useCallback((value:unknown) => {const result=movementPage(value); if(result.items.some(row => row.ingredient_id !== ingredient.id)) throw new Error('Movement history does not match this ingredient.'); return result;},[ingredient.id]);
  const state = useInventoryRecord(client, revision, `/ingredients/${encodeURIComponent(ingredient.id)}/movements?page=${page}`, validate);
  useEffect(() => {if (requested && located?.page && state.value?.items.some(row => row.id === requested)) {const element = document.getElementById(`movement-${requested}`); element?.scrollIntoView?.({block: 'center'}); element?.focus({preventScroll: true});}}, [requested, located, state.value]);
  const locating = Boolean(requested && (!located || located.id !== requested || !located.page));
  return <section className="page-section"><h2>Stock movements</h2>{requested && <Link className="back-link" to={`?${new URLSearchParams([...params].filter(([key]) => !['movement_id','movement_page'].includes(key)))}`}>Full movement history</Link>}{locating ? located?.error ? <Feedback error>{located.error}<button className="text-action" onClick={() => setLocateRetry(value => value + 1)}>Retry linked movement</button></Feedback> : <Loading>Locating linked movement...</Loading> : !state.value ? <ReadState error={state.error} retry={state.retry} loading="Loading stock movements..." /> : <>
    {state.value.items.length ? <table className="ledger-table"><thead><tr><th>Recorded / type</th><th>Stock change</th><th>Before / after</th><th>Reason / links</th></tr></thead><tbody>{state.value.items.map(item => <tr id={`movement-${item.id}`} key={item.id} tabIndex={-1}>
      <th scope="row">{formatBusinessTime(item.recorded_at, settings.timezone)}<small>{item.type}</small><small>{item.recorded_by}</small></th><td data-label="Stock change">{item.delta_base_quantity} {ingredient.base_unit}</td><td data-label="Before / after">{item.before_quantity} {ingredient.base_unit} -&gt; {item.after_quantity} {ingredient.base_unit}</td>
      <td data-label="Reason / links" className="inventory-links"><p>{item.reason}</p>{item.purchase_id && <Link to={`/purchases/${encodeURIComponent(item.purchase_id)}`}>Purchase receipt</Link>}{item.corrects_movement_id && <Link to={`?movement_id=${encodeURIComponent(item.corrects_movement_id)}#movement-${item.corrects_movement_id}`}>Corrected movement</Link>}{item.preparation_id && <Link to={`/preparations/${encodeURIComponent(item.preparation_id)}`}>Preparation record</Link>}</td>
    </tr>)}</tbody></table> : <p className="empty-state">No stock movements yet.</p>}
    <InventoryPagination value={state.value} label="movements" change={page => {const next = new URLSearchParams(params); next.delete('movement_id'); next.set('movement_page', String(page)); setParams(next);}} />
  </>}</section>;
}
function PriceHistory({ingredient}: {ingredient: Ingredient}) {
  const {client, revision} = useInventory(), [params, setParams] = useSearchParams();
  const validate = useCallback((value:unknown) => {const result=pricePage(value); if(result.items.some(row => row.ingredient_id !== ingredient.id || row.base_unit !== ingredient.base_unit)) throw new Error('Price history does not match this ingredient.'); return result;},[ingredient.id,ingredient.base_unit]);
  const state = useInventoryRecord(client, revision, `/ingredients/${encodeURIComponent(ingredient.id)}/prices?page=${params.get('price_page') ?? '1'}`, validate);
  return <section className="page-section"><h2>Purchase price history</h2>{!state.value ? <ReadState error={state.error} retry={state.retry} loading="Loading purchase prices..." /> : <>
    {state.value.items.length ? <table className="ledger-table"><thead><tr><th>Receipt / supplier</th><th>Purchased on</th><th>Quantity / cost</th><th>Comparable unit cost</th></tr></thead><tbody>{state.value.items.map(item => <tr key={item.id}><th scope="row"><Link to={`/purchases/${encodeURIComponent(item.purchase_id)}`}>{item.reference}</Link><small>{item.supplier}</small></th>
      <td data-label="Purchased on">{formatCalendarDate(item.purchased_on)}</td><td data-label="Quantity / cost">{item.quantity} {item.unit}<small>{item.base_quantity} {item.base_unit}</small><small>{formatMoney(item.total_cost_minor, item)}</small></td><td data-label="Comparable cost">{comparableCost(item.unit_cost, item.base_unit, item.currency)}</td></tr>)}</tbody></table> : <p className="empty-state">No purchase prices yet.</p>}
    <InventoryPagination value={state.value} label="prices" change={page => {const next = new URLSearchParams(params); next.set('price_page', String(page)); setParams(next);}} />
  </>}</section>;
}
export function PurchaseDetails() {
  const {id = ''} = useParams(), {client, revision, settings} = useInventory();
  const validate = useCallback((value: unknown) => {const receipt = checkedPurchase(value); if (receipt.id !== id) throw new Error('Receipt does not match this page.'); return receipt;}, [id]);
  const state = useInventoryRecord(client, revision, `/purchases/${encodeURIComponent(id)}`, validate);
  return <><Back fallback="purchases" />{!state.value ? <ReadState error={state.error} retry={state.retry} loading="Loading receipt..." /> : <>
    <div className="page-heading"><h1>{state.value.reference}</h1></div><dl className="order-facts page-section"><div><dt>Supplier</dt><dd>{state.value.supplier}</dd></div><div><dt>Purchased on</dt><dd>{formatCalendarDate(state.value.purchased_on)}</dd></div><div><dt>Recorded</dt><dd>{formatBusinessTime(state.value.recorded_at, settings.timezone)}<small>{state.value.recorded_by}</small></dd></div><div><dt>Total ingredient cost</dt><dd>{formatMoney(state.value.total_cost_minor, state.value)}</dd></div></dl>
    <section className="page-section"><h2>Receipt items</h2><table className="snapshot-table"><thead><tr><th>Ingredient</th><th>Purchased / normalized</th><th>Total ingredient cost</th><th>Comparable unit cost</th></tr></thead><tbody>{state.value.items.map(item => <tr key={item.id}><th scope="row"><Link to={`/ingredients/${encodeURIComponent(item.ingredient_id)}`}>{item.ingredient_name}</Link></th>
      <td data-label="Quantity" className="inventory-links">{item.quantity} {item.unit}{item.pack_contents && <small>{item.pack_contents.quantity} {item.pack_contents.unit} per {item.unit}</small>}<small>{item.base_quantity} {item.base_unit}</small><Link to={`/ingredients/${encodeURIComponent(item.ingredient_id)}?movement_id=${encodeURIComponent(item.stock_movement_id)}#movement-${item.stock_movement_id}`}>Stock movement</Link></td><td data-label="Total cost">{formatMoney(item.total_cost_minor, state.value!)}</td><td data-label="Comparable cost">{comparableCost(item.unit_cost, item.base_unit, state.value!.currency)}</td>
    </tr>)}</tbody></table>{state.value.note && <p className="order-notes">{state.value.note}</p>}</section>
  </>}</>;
}
export function LowStock({client, settings}: {client: ApiClient; settings: BusinessSettings}) {
  return settings.capabilities.inventory ? <LowStockRecords client={client} settings={settings} /> : null;
}
function LowStockRecords({client, settings}: {client: ApiClient; settings: BusinessSettings}) {
  const state = useInventoryRecord<PageResult<Ingredient>>(client, 0, '/ingredients?low_stock=true', ingredientPage), location = useLocation();
  return <section className="page-section"><div className="section-heading"><h2>Low physical stock</h2><Link to="/ingredients?low_stock=true">View all low-stock ingredients</Link></div>
    {!state.value ? <ReadState error={state.error} retry={state.retry} loading="Loading low-stock ingredients..." /> : state.value.items.length ? <IngredientTable items={state.value.items} settings={settings} route={location.pathname + location.search} /> : <p className="empty-state">No ingredients below their stock threshold.</p>}
  </section>;
}
