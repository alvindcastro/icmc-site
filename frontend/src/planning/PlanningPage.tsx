import {Link, useSearchParams} from 'react-router-dom';
import {ChefHat, ShoppingBasket} from 'lucide-react';
import type {ApiClient} from '../api/client';
import type {BusinessSettings} from '../api/types';
import {Feedback, Field} from '../components/ui';
import {scaledQuantity} from '../inventory/model';
import {ReadState, useInventoryRecord} from '../inventory/reads';
import {formatBusinessTime, formatCalendarDate, statusLabel} from '../lib/format';
import {sellingLabel} from '../menu/model';
import {useOrders} from '../orders/OrderArea';
import {preparationEnabled, preparationOperationMarker} from '../preparation/model';
import {checkedPlanning} from './responses';
import type {Planning, PlanningMissing} from './types';

export const planningEnabled = (settings: BusinessSettings) => settings.capabilities.orders && settings.capabilities.planning;
const some = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
export const periodLabel = (value: Planning['period']) => value.date_from === value.date_to ? formatCalendarDate(value.date_from) : `${formatCalendarDate(value.date_from)} to ${formatCalendarDate(value.date_to)}`;
const query = (from: string, to: string, view = '') => `/planning${view}?${new URLSearchParams({date_from: from, date_to: to})}`;
export function MissingRecipes({missing}: {missing: PlanningMissing[]}) {
  return <>{missing.map(gap => <p key={gap.variant_id} className="inventory-links">
    <Link to={`/menu/${encodeURIComponent(gap.food_id)}/variants/${encodeURIComponent(gap.variant_id)}/recipe`}>{`Add recipe for ${gap.variant_label} of ${gap.food_name}`}</Link>
    {gap.orders.map(order => <Link key={order.order_id} to={`/orders/${encodeURIComponent(order.order_id)}`}>{order.reference}</Link>)}</p>)}</>;
}

export function PlanningPage() {
  const {client, settings, revision} = useOrders(), [params, setParams] = useSearchParams(), enabled = planningEnabled(settings);
  const from = params.get('date_from'), to = params.get('date_to');
  // Without a complete period the backend plans for its own business date; the browser never decides what today is.
  const state = useInventoryRecord(client, revision, !enabled ? null : from && to ? query(from, to) : '/planning', checkedPlanning), plan = state.value;
  if (!enabled) return <><h1>Planning unavailable</h1><Feedback>Planning is not enabled for this workspace.</Feedback></>;
  function change(key: 'date_from' | 'date_to', value: string) {
    const current = {date_from: from ?? plan?.period.date_from ?? value, date_to: to ?? plan?.period.date_to ?? value};
    if (!value) {setParams({}, {replace: true}); return;}
    const next = {...current, [key]: value};
    // Moving one end past the other moves both, so the period sent is always valid.
    if (next.date_from > next.date_to) next[key === 'date_from' ? 'date_to' : 'date_from'] = value;
    setParams(next, {replace: true});
  }
  const shown = plan?.period ?? (from && to ? {date_from: from, date_to: to} : null);
  return <><div className="page-heading"><div><span className="eyebrow">PREPARATION PLANNING</span><h1>Planning</h1></div>
      <div className="heading-actions">{preparationEnabled(settings) && plan?.permitted_actions.record_preparation.allowed && plan.foods.some(food => food.remaining_quantity > 0) && <Link className="button primary" to={query(plan.period.date_from, plan.period.date_to, '/prepare')}><ChefHat size={17} />Record preparation</Link>}
        <Link className="button secondary" to={shown ? query(shown.date_from, shown.date_to, '/shopping-list') : '/planning/shopping-list'}><ShoppingBasket size={17} />Shopping list</Link></div></div>
    {preparationEnabled(settings) && sessionStorage.getItem(preparationOperationMarker) && <div className="menu-notice"><Feedback>An earlier preparation save is unresolved.<Link className="text-action" to={shown ? query(shown.date_from, shown.date_to, '/prepare') : '/planning/prepare'}>Check it before recording more</Link></Feedback></div>}
    <div className="menu-filters order-filters"><Field id="planning-from" label="From date" type="date" value={from ?? plan?.period.date_from ?? ''} onChange={event => change('date_from', event.target.value)} />
      <Field id="planning-to" label="To date" type="date" value={to ?? plan?.period.date_to ?? ''} onChange={event => change('date_to', event.target.value)} /><small>{settings.timezone}</small></div>
    {!plan ? <ReadState error={state.error} retry={state.retry} loading="Loading planning..." /> : <>
      <div className="menu-count"><span>{periodLabel(plan.period)}</span><span className={`status-label ${plan.complete ? 'success' : 'warning'}`}>{plan.complete ? 'Complete' : 'Incomplete'}</span></div>
      {!plan.complete && <div className="menu-notice"><Feedback error><p>Planning is incomplete. Quantities below are a lower bound until every ordered variant has a recipe.</p><MissingRecipes missing={plan.missing} /></Feedback></div>}
      <section className="page-section" aria-labelledby="cook-heading"><h2 id="cook-heading">What to cook</h2>
        {!plan.foods.length ? <p className="empty-state">Nothing to prepare for this period.</p> : <table className="ledger-table"><thead><tr><th>Food / variant</th><th>Ordered</th><th>Prepared</th><th>Remaining</th><th>Orders</th></tr></thead>
          <tbody>{plan.foods.map(food => <tr key={`${food.variant_id}/${food.selling_unit}/${food.package_contents?.quantity ?? ''}`}>
            <th scope="row">{food.food_name}<small>{`${food.variant_label} / ${sellingLabel(food.selling_unit, food.package_contents)}`}</small></th>
            <td data-label="Ordered">{food.ordered_quantity}</td><td data-label="Prepared">{food.prepared_quantity}</td><td data-label="Remaining">{food.remaining_quantity}</td>
            <td data-label="Orders"><div className="planning-orders">{food.orders.map(order => <span key={order.order_item_id}><Link to={`/orders/${encodeURIComponent(order.order_id)}`}>{order.reference}</Link>
              <small>{`${order.remaining_quantity} remaining / ${statusLabel(order.status)}`}</small></span>)}</div></td></tr>)}</tbody></table>}
      </section>
      <section className="page-section" aria-labelledby="needs-heading"><h2 id="needs-heading">Ingredients needed</h2>
        {!plan.ingredients.length ? <p className="empty-state">No ingredient demand for this period.</p> : <table className="ledger-table"><thead><tr><th>Ingredient</th><th>Physical stock</th><th>Earlier commitments</th><th>This period</th><th>Stock after earlier</th><th>Shortage</th></tr></thead>
          <tbody>{plan.ingredients.map(row => <tr key={row.ingredient_id}><th scope="row"><Link to={`/ingredients/${encodeURIComponent(row.ingredient_id)}`}>{row.ingredient_name}</Link></th>
            <td data-label="Physical stock">{`${row.stock_on_hand} ${row.base_unit}`}</td><td data-label="Earlier commitments">{`${row.earlier_demand} ${row.base_unit}`}</td><td data-label="This period">{`${row.period_demand} ${row.base_unit}`}</td>
            <td data-label="Stock after earlier">{`${row.stock_after_earlier} ${row.base_unit}`}</td>
            <td data-label="Shortage">{scaledQuantity(row.cumulative_shortage) === 0n ? 'None' : <><span>{`${row.period_shortage} ${row.base_unit} this period`}</span><small>{`${row.cumulative_shortage} ${row.base_unit} through this period`}</small></>}</td></tr>)}</tbody></table>}
        <p className="estimate-note">{`Calculated ${formatBusinessTime(plan.calculated_at, plan.timezone)} from current physical stock. Planning reserves nothing and changes no stock.`}</p>
      </section>
    </>}
  </>;
}

export function PreparationSummary({client, settings, revision, date}: {client: ApiClient; settings: BusinessSettings; revision: number; date: string}) {
  return planningEnabled(settings) ? <Summary client={client} revision={revision} date={date} /> : null;
}
function Summary({client, revision, date}: {client: ApiClient; revision: number; date: string}) {
  const state = useInventoryRecord(client, revision, query(date, date), checkedPlanning), plan = state.value;
  const remaining = plan?.foods.reduce((sum, food) => sum + food.remaining_quantity, 0) ?? 0, short = plan?.ingredients.filter(row => scaledQuantity(row.cumulative_shortage) > 0n).length ?? 0;
  return <section className="page-section" aria-labelledby="preparation-heading"><div className="section-heading"><h2 id="preparation-heading">Preparation</h2><span className="summary-links"><Link to={query(date, date)}>Open planning</Link><Link to={query(date, date, '/shopping-list')}>Shopping list</Link></span></div>
    {!plan ? <ReadState error={state.error} retry={state.retry} loading="Loading preparation summary..." /> : <dl className="order-facts">
      <div><dt>To prepare</dt><dd><span>{plan.foods.length ? `${some(remaining, 'unit', 'units')} of ${some(plan.foods.length, 'variant', 'variants')}` : 'Nothing to prepare'}</span>
        {!plan.complete && <small><span className="status-label warning">Incomplete</span> {`${some(plan.missing.length, 'variant', 'variants')} without a recipe`}</small>}</dd></div>
      <div><dt>Ingredient shortages</dt><dd>{short ? `${some(short, 'ingredient', 'ingredients')} short` : 'None'}</dd></div></dl>}
  </section>;
}
