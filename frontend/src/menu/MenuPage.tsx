import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Pencil, Search, RotateCw, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { ApiError, type ApiClient } from '../api/client';
import { heldAttempt, rejectedOutright, releaseAttempt } from '../api/pending';
import type { BusinessSettings, Category, Food, MenuOperation, MenuVariant, PageResult } from '../api/types';
import { useSession } from '../auth/session';
import { Feedback, Field, IconButton, Loading } from '../components/ui';
import { formatMoney } from '../lib/format';
import { MenuEditor, menuOperationMarker, type EditorTarget } from './Editor';
import { recipesEnabled } from '../recipes/model';
import { sellingLabel } from './model';
import { checkedCategory, checkedFood, checkedOperation, checkedPage, checkedVariant } from './responses';

export function MenuPage({client}: {client: ApiClient}) {
  const {settings, settingsError, loadSettings} = useSession();
  if (!settings) return <><h1>Menu</h1>{settingsError ? <Feedback error>{settingsError}<button className="button secondary" onClick={() => void loadSettings()}><RotateCw size={17} />Retry business settings</button></Feedback> : <Loading>Loading business settings...</Loading>}</>;
  if (!settings.capabilities.menu) return <><h1>Menu</h1><Feedback>Menu management is not enabled.</Feedback></>;
  return <MenuContent client={client} settings={settings} />;
}
function MenuContent({client, settings}: {client: ApiClient; settings: BusinessSettings}) {
  const [params, setParams] = useSearchParams();
  const [categories, setCategories] = useState<Category[]>([]);
  const [foods, setFoods] = useState<PageResult<Food> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState<EditorTarget | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(() => sessionStorage.getItem(menuOperationMarker));
  const [checking, setChecking] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [retryAllowed, setRetryAllowed] = useState(false);
  const focusReturn = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const active = useRef(true);
  useEffect(() => () => {active.current = false;}, []);
  const query = params.toString();
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setLoading(true); setError(null); setFoods(null);
    async function load() {
      try {
        const categoryItems: Category[] = [];
        let page = 1;
        while (true) {
          const response = checkedPage(await client.request(`/categories?limit=100&page=${page}`, {signal: controller.signal}), checkedCategory);
          categoryItems.push(...response.items);
          if (!response.has_next) break;
          if (++page > 100) throw new Error('The category list could not be loaded completely.');
        }
        const filters = new URLSearchParams(query);
        if (!filters.has('page')) filters.set('page', '1');
        filters.set('limit', '25');
        const response = checkedPage(await client.request(`/foods?${filters}`, {signal: controller.signal}), checkedFood);
        if (current) {setCategories(categoryItems); setFoods(response);}
      } catch (failure) {if (current) setError((failure as Error).message);}
      finally {if (current) setLoading(false);}
    }
    void load();
    return () => {current = false; controller.abort();};
  }, [client, query, revision]);
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params); next.delete('page');
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, {replace: true});
  }
  function open(next: EditorTarget) {focusReturn.current = document.activeElement as HTMLElement; setTarget(next); setMessage(null);}
  function close() {
    setTarget(null); setPending(sessionStorage.getItem(menuOperationMarker));
    requestAnimationFrame(() => {const button = focusReturn.current?.isConnected ? focusReturn.current : addButton.current; button?.focus();});
  }
  function saved(result: string) {setMessage(result); close(); setRevision(value => value + 1);}
  async function recover() {
    if (!pending || checking) return;
    setChecking(true); setRecoveryError(null); setRetryAllowed(false);
    try {
      const operation = checkedOperation(await client.request<MenuOperation>(`/operations/${encodeURIComponent(pending)}`), pending);
      if (!active.current) return;
      if (operation.operation_id !== pending) throw new Error('The server returned an invalid save status.');
      if (operation.state === 'succeeded' && operation.result?.body?.id || operation.state === 'rejected' && operation.error) {
        releaseAttempt(menuOperationMarker); setPending(null); setRevision(value => value + 1);
        setMessage(operation.state === 'succeeded' ? 'Previous menu save confirmed.' : operation.error!.error.message);
      } else if (operation.state === 'processing') setRecoveryError('The previous save is still processing.');
      else throw new Error('The server returned an invalid save status.');
    } catch (failure) {
      if (!active.current) return;
      // The exact request outlives its editor in memory; without it a missing operation stays an operator matter.
      const retained = failure instanceof ApiError && failure.status === 404 && Boolean(heldAttempt(menuOperationMarker));
      setRetryAllowed(retained);
      setRecoveryError(retained ? 'No result yet. Only the exact original submission can be retried.' : 'Previous save remains unconfirmed. Check again or ask the backend operator to reconcile it.');
    } finally {if (active.current) setChecking(false);}
  }
  async function retry() {
    const attempt = heldAttempt(menuOperationMarker);
    if (!attempt || checking) return;
    setChecking(true); setRecoveryError(null); setRetryAllowed(false);
    try {
      const result = await client.request<Food | MenuVariant>(attempt.path, {method: attempt.method, body: attempt.body, operationId: attempt.id});
      if (!active.current) return;
      if ('food_id' in result) checkedVariant(result); else checkedFood(result);
      releaseAttempt(menuOperationMarker); setPending(null); setRevision(value => value + 1); setMessage('Previous menu save confirmed.');
    } catch (failure) {
      if (!active.current) return;
      if (rejectedOutright(failure)) {releaseAttempt(menuOperationMarker); setPending(null); setMessage(failure.message);}
      else setRecoveryError('Previous save remains unconfirmed. Check its status again.');
    } finally {if (active.current) setChecking(false);}
  }
  const filtered = Boolean(params.get('q') || params.get('category_id') || params.get('available'));
  const recipes = recipesEnabled(settings), returnTo = query ? `/menu?${query}` : '/menu';
  return <>
    <div className="page-heading"><div><span className="eyebrow">FOODS & SELLING FORMATS</span><h1>Menu</h1></div>
      <button ref={addButton} className="button primary" disabled={loading || Boolean(error) || Boolean(pending) || !categories.length} onClick={() => open({kind: 'food'})}><Plus size={18} />Add food</button></div>
    {settings.environment === 'development' && <div className="menu-notice"><Feedback>Provisional development menu</Feedback></div>}
    {message && <Feedback>{message}</Feedback>}
    {pending && !target && <Feedback error>Previous menu save needs reconciliation.
      {recoveryError && <p>{recoveryError}</p>}<button className="button secondary" disabled={checking} onClick={() => void recover()}><RotateCw size={17} />Check previous save</button>
      {retryAllowed && <button className="button secondary" disabled={checking} onClick={() => void retry()}><RotateCw size={17} />Retry original save</button>}</Feedback>}
    <div className="menu-filters">
      <Field id="menu-search" label="Search menu" value={params.get('q') ?? ''} maxLength={200} onChange={event => filter('q', event.target.value)} suffix={<Search size={18} className="search-icon" aria-hidden="true" />} />
      <div className="field"><label htmlFor="category-filter">Category filter</label><select id="category-filter" value={params.get('category_id') ?? ''} onChange={event => filter('category_id', event.target.value)}>
        <option value="">All categories</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div>
      <div className="field"><label htmlFor="availability-filter">Availability filter</label><select id="availability-filter" value={params.get('available') ?? ''} onChange={event => filter('available', event.target.value)}>
        <option value="">All availability</option><option value="true">Available foods</option><option value="false">Unavailable foods</option></select></div>
      {filtered && <IconButton label="Clear filters" onClick={() => setParams({})}><X size={19} /></IconButton>}
    </div>
    {loading ? <Loading>Loading menu...</Loading> : error ? <Feedback error>{error}<button className="button secondary" onClick={() => setRevision(value => value + 1)}><RotateCw size={17} />Retry menu</button></Feedback>
      : foods && <>
        <div className="menu-count"><span>{foods.total} {foods.total === 1 ? 'food' : 'foods'}</span><span>Prices in {settings.currency}</span></div>
        {foods.items.length === 0 ? <div className="empty-state"><h2>{filtered ? 'No foods match these filters.' : foods.total ? 'No foods on this page.' : 'No foods yet.'}</h2>
          {!filtered && foods.total > 0 ? <button className="button secondary" onClick={() => filter('page', '1')}><ChevronLeft size={17} />First page</button> : null}</div>
          : foods.items.map(food => <section className="food-section" key={food.id} aria-labelledby={`food-${food.id}`}>
            <div className="food-heading"><div className="food-identity"><span className="food-category">{categories.find(category => category.id === food.category_id)?.name ?? 'Unknown category'}</span>
              <h2 id={`food-${food.id}`}>{food.name}</h2>{food.description && <p>{food.description}</p>}</div>
              <div className="food-actions"><span className={`status-label ${food.available ? 'success' : 'neutral'}`}>{food.available ? 'Available' : 'Unavailable'}</span>
                <span className={`status-label ${food.confirmation_status === 'confirmed' ? 'success' : 'warning'}`}>{food.confirmation_status === 'confirmed' ? 'Confirmed' : 'Provisional'}</span>
                <IconButton label={`Edit food ${food.name}`} disabled={Boolean(pending) || !food.permitted_actions.edit.allowed} title={food.permitted_actions.edit.reason ?? `Edit food ${food.name}`} onClick={() => open({kind: 'food', food})}><Pencil size={17} /></IconButton></div></div>
            <table className={`variant-table${recipes ? ' with-recipes' : ''}`}><caption className="sr-only">Variants of {food.name}</caption><thead><tr><th>Variant</th><th>Quantity per unit</th><th>Price</th><th>Availability</th>{recipes && <th>Recipe</th>}<th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{food.variants.map(variant => <tr key={variant.id}><th scope="row"><span>{variant.label}</span><small>{variant.confirmation_status === 'confirmed' ? 'Confirmed' : 'Provisional'}</small></th>
                <td data-label="Quantity">{sellingLabel(variant.selling_unit, variant.package_contents)}</td><td data-label="Price" className="money">{formatMoney(variant.price_minor, settings)}</td>
                <td data-label="Availability"><span className={`status-label ${variant.available && food.available ? 'success' : 'neutral'}`}>{!variant.available ? 'Unavailable' : food.available ? 'Available' : 'Food unavailable'}</span></td>
                {recipes && <td data-label="Recipe"><span className="variant-recipe">{!variant.recipe_id && <span className="status-label warning">No recipe</span>}
                  <Link to={`/menu/${encodeURIComponent(food.id)}/variants/${encodeURIComponent(variant.id)}/recipe`} state={{returnTo}} aria-label={`${variant.recipe_id ? 'Recipe and estimate' : 'Add recipe'} for ${variant.label} of ${food.name}`}>{variant.recipe_id ? 'Recipe and estimate' : 'Add recipe'}</Link></span></td>}
                <td className="variant-action"><IconButton label={`Edit variant ${variant.label} of ${food.name}`} disabled={Boolean(pending) || !variant.permitted_actions.edit.allowed} title={variant.permitted_actions.edit.reason ?? `Edit variant ${variant.label} of ${food.name}`}
                  onClick={() => open({kind: 'variant', food, variant})}><Pencil size={17} /></IconButton></td></tr>)}</tbody></table>
            {!food.variants.length && <p className="no-variants">No variants yet.</p>}
            <button className="button secondary add-variant" aria-label={`Add variant to ${food.name}`} disabled={Boolean(pending) || !food.permitted_actions.add_variant.allowed}
              title={food.permitted_actions.add_variant.reason ?? undefined} onClick={() => open({kind: 'variant', food})}><Plus size={17} />Add variant</button>
          </section>)}
        <div className="pagination"><span>Page {foods.page}</span><div><IconButton label="Previous menu page" disabled={foods.page <= 1} onClick={() => filter('page', String(foods.page - 1))}><ChevronLeft size={20} /></IconButton>
          <IconButton label="Next menu page" disabled={!foods.has_next} onClick={() => filter('page', String(foods.page + 1))}><ChevronRight size={20} /></IconButton></div></div>
      </>}
    {target && <MenuEditor target={target} client={client} settings={settings} categories={categories} onClose={close} onSaved={saved} />}
  </>;
}
