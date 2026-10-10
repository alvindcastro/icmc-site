import {useEffect, useState} from 'react';
import {Link, useLocation, useParams} from 'react-router-dom';
import {ArrowLeft, Pencil, Plus} from 'lucide-react';
import {ApiError, type ApiClient} from '../api/client';
import type {BusinessSettings, Food, MenuVariant} from '../api/types';
import {useSession} from '../auth/session';
import {Feedback, Loading} from '../components/ui';
import {comparableCost, preciseAmount} from '../inventory/model';
import {ReadFailure} from '../inventory/reads';
import {formatBusinessTime, formatCalendarDate, formatMoney} from '../lib/format';
import {sellingLabel} from '../menu/model';
import {checkedFood} from '../menu/responses';
import {recipesEnabled, sameYield, yieldOf} from './model';
import {RecipeEditor} from './RecipeEditor';
import {checkedEstimate, checkedRecipe} from './responses';
import type {Estimate, Recipe, RecipeYield} from './types';

type Loaded = {food: Food; variant: MenuVariant; recipe: Recipe | null; estimate: Estimate};
const yieldLabel = (value: RecipeYield) => sellingLabel(value.selling_unit, value.package_contents);
const missingRecipe = (failure: unknown) => {if (failure instanceof ApiError && failure.status === 404) return null; throw failure;};

export function RecipePage({client}: {client: ApiClient}) {
  const {settings, settingsError, loadSettings} = useSession();
  if (!settings) return settingsError ? <Feedback error>{settingsError}<button className="text-action" onClick={() => void loadSettings()}>Retry settings</button></Feedback> : <Loading>Loading settings...</Loading>;
  if (!recipesEnabled(settings)) return <><h1>Recipes unavailable</h1><Feedback>Recipes are not enabled for this workspace.</Feedback></>;
  if (settings.environment !== 'development' && (settings.environment !== 'live' || !settings.confirmation.currency || !settings.confirmation.timezone)) {
    return <><h1>Recipes</h1><Feedback error>Business currency and timezone require confirmation before live recipes and estimates.</Feedback></>;
  }
  return <RecipeContent client={client} settings={settings} />;
}
function RecipeContent({client, settings}: {client: ApiClient; settings: BusinessSettings}) {
  const {foodId = '', variantId = ''} = useParams(), requested = useLocation().state?.returnTo, key = `${foodId}/${variantId}`;
  const returnTo = typeof requested === 'string' && /^\/menu(\?|$)/.test(requested) && !/[\\\r\n]/.test(requested) ? requested : '/menu';
  const [revision, setRevision] = useState(0), [state, setState] = useState<{key: string; value?: Loaded; error?: string}>({key});
  const [editing, setEditing] = useState(false), [message, setMessage] = useState('');
  useEffect(() => {
    let active = true; const controller = new AbortController(), signal = controller.signal; setState({key});
    void (async () => {
      const food = checkedFood(await client.request(`/foods/${encodeURIComponent(foodId)}`, {signal})), variant = food.variants.find(item => item.id === variantId);
      if (food.id !== foodId || !variant) throw new Error('This variant is not part of this food.');
      const path = `/variants/${encodeURIComponent(variantId)}`;
      // Each read is current; the estimate is the backend's calculation, never derived here from the recipe.
      const [recipe, estimate] = await Promise.all([client.request(`${path}/recipe`, {signal}).then(checkedRecipe, missingRecipe), client.request(`${path}/estimate`, {signal}).then(checkedEstimate)]);
      if (recipe && recipe.variant_id !== variantId) throw new Error('The recipe does not match this variant.');
      if (estimate.variant_id !== variantId || estimate.currency !== settings.currency) throw new Error('The estimate does not match this variant.');
      if (active) setState({key, value: {food, variant, recipe, estimate}});
    })().catch(failure => {if (active) setState({key, error: failure.message});});
    return () => {active = false; controller.abort();};
  }, [client, foodId, variantId, key, revision, settings.currency]);
  const back = <Link className="back-link" to={returnTo}><ArrowLeft size={16} />Back to menu</Link>;
  const loaded = state.key === key ? state.value : undefined;
  if (!loaded) return <>{back}{state.key === key && state.error ? <ReadFailure message={state.error} retry={() => setRevision(value => value + 1)} /> : <Loading>Loading recipe and estimate...</Loading>}</>;
  const {food, variant, recipe, estimate} = loaded, selling = yieldOf(variant);
  return <>{back}
    <div className="page-heading order-detail-heading"><div><span className="eyebrow">RECIPE & INGREDIENT ESTIMATE</span><h1>{food.name}</h1><small>{`${variant.label} / ${yieldLabel(selling)}`}</small></div>
      <button className="button primary" onClick={() => {setMessage(''); setEditing(true);}}>{recipe ? <Pencil size={17} /> : <Plus size={17} />}{recipe ? 'Edit recipe' : 'Add recipe'}</button></div>
    {settings.environment === 'development' && <div className="menu-notice"><Feedback>Sample development recipes</Feedback></div>}
    {message && <div className="menu-notice"><Feedback>{message}</Feedback></div>}
    <section className="page-section" aria-labelledby="recipe-heading"><div className="section-heading"><h2 id="recipe-heading">Recipe</h2>{recipe && <small>{`Recipe version ${recipe.version}`}</small>}</div>
      {!recipe ? <p className="empty-state">No recipe yet.</p> : <>
        {sameYield(recipe.yield, selling) ? <p>{`Makes exactly ${yieldLabel(recipe.yield)}.`}</p> : <Feedback error>{`This recipe was written for ${yieldLabel(recipe.yield)}. Review and save it for ${yieldLabel(selling)}.`}</Feedback>}
        <table className="snapshot-table"><thead><tr><th>Ingredient</th><th>Quantity for one unit</th></tr></thead><tbody>{recipe.items.map(item => <tr key={item.ingredient_id}>
          <th scope="row"><Link to={`/ingredients/${encodeURIComponent(item.ingredient_id)}`}>{item.ingredient_name}</Link></th><td data-label="Quantity">{`${item.quantity} ${item.unit}`}</td></tr>)}</tbody></table>
      </>}
    </section>
    <EstimateSection estimate={estimate} recipe={recipe} settings={settings} />
    {editing && <RecipeEditor client={client} food={food} variant={variant} recipe={recipe} onClose={() => setEditing(false)}
      onSaved={() => {setEditing(false); setMessage('Recipe saved.'); setRevision(value => value + 1);}} />}
  </>;
}
function EstimateSection({estimate, recipe, settings}: {estimate: Estimate; recipe: Recipe | null; settings: BusinessSettings}) {
  const amount = (value: number | null) => value === null ? 'Incomplete' : formatMoney(value, settings);
  const ingredient = (id: string, name: string) => <Link to={`/ingredients/${encodeURIComponent(id)}`}>{name}</Link>;
  return <section className="page-section" aria-labelledby="estimate-heading"><div className="section-heading"><h2 id="estimate-heading">Ingredient estimate</h2>
      <span className={`status-label ${estimate.complete ? 'success' : 'warning'}`}>{estimate.complete ? 'Complete' : 'Incomplete'}</span></div>
    {!estimate.complete && <Feedback error>{estimate.missing.map(item => item.code === 'recipe_missing'
      ? <p key="recipe">{recipe ? 'No recipe for the current selling format.' : 'No recipe for this variant.'}</p>
      : <p key={item.ingredient_id}>No purchase price for {ingredient(item.ingredient_id!, estimate.basis.find(row => row.ingredient_id === item.ingredient_id)!.ingredient_name)}.</p>)}</Feedback>}
    <dl className="order-totals estimate-totals"><div><dt>Selling price</dt><dd className="money">{formatMoney(estimate.selling_price_minor, settings)}</dd></div>
      <div><dt>Estimated ingredient cost</dt><dd className="money">{amount(estimate.ingredient_cost_minor)}</dd></div>
      <div><dt>Ingredient contribution estimate</dt><dd className="money">{amount(estimate.ingredient_contribution_minor)}</dd></div></dl>
    <p className="estimate-note">Ingredient contribution estimate = selling price − estimated ingredient cost. It is not net profit and excludes labour, packaging, utilities and delivery.</p>
    {estimate.basis.length > 0 && <><table className="ledger-table"><thead><tr><th>Ingredient</th><th>Recipe quantity</th><th>Purchase basis</th><th>Unit cost</th><th>Estimated amount</th></tr></thead><tbody>{estimate.basis.map(row => <tr key={row.ingredient_id}>
      <th scope="row">{ingredient(row.ingredient_id, row.ingredient_name)}</th><td data-label="Recipe quantity">{`${row.base_quantity} ${row.base_unit}`}</td>
      <td data-label="Purchase basis" className="inventory-links">{row.purchase_id === null ? 'No purchase price' : <>{formatCalendarDate(row.purchased_on!)}
        {settings.capabilities.purchases && <Link to={`/purchases/${encodeURIComponent(row.purchase_id)}`}>Purchase receipt</Link>}</>}</td>
      <td data-label="Unit cost">{comparableCost(row.unit_cost, row.base_unit, estimate.currency)}</td>
      <td data-label="Estimated amount" className="money">{row.estimated_cost === null ? 'Unknown' : preciseAmount(row.estimated_cost, estimate.currency)}</td></tr>)}</tbody></table>
      <p className="estimate-note">{`Latest purchase prices as calculated ${formatBusinessTime(estimate.calculated_at, settings.timezone)}. Row amounts are exact; the total is rounded once.`}</p></>}
  </section>;
}
