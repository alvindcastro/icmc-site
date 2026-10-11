import {Link, useSearchParams} from 'react-router-dom';
import {ArrowLeft, Printer} from 'lucide-react';
import {Feedback} from '../components/ui';
import {ReadState, useInventoryRecord} from '../inventory/reads';
import {formatBusinessTime} from '../lib/format';
import {useOrders} from '../orders/OrderArea';
import {MissingRecipes, periodLabel, planningEnabled} from './PlanningPage';
import {checkedShoppingList} from './responses';

export function ShoppingListPage() {
  const {client, settings, revision} = useOrders(), [params] = useSearchParams(), enabled = planningEnabled(settings);
  const from = params.get('date_from'), to = params.get('date_to'), search = from && to ? `?${new URLSearchParams({date_from: from, date_to: to})}` : '';
  const state = useInventoryRecord(client, revision, enabled ? `/planning/shopping-list${search}` : null, checkedShoppingList), list = state.value;
  if (!enabled) return <><h1>Planning unavailable</h1><Feedback>Planning is not enabled for this workspace.</Feedback></>;
  return <><div className="print-toolbar"><Link className="back-link" to={`/planning${search}`}><ArrowLeft size={16} />Back to planning</Link>
      <button className="button primary" disabled={!list} onClick={() => window.print()}><Printer size={18} />Print shopping list</button></div>
    {!list ? <ReadState error={state.error} retry={state.retry} loading="Loading shopping list..." /> : <section aria-label="Printable shopping list" className="print-summary">
      <div className="page-heading"><div><span className="eyebrow">INGREDIENTS TO BUY</span><h1>Shopping list</h1><small>{`${periodLabel(list.period)} / ${list.timezone}`}</small></div>
        <span className={`status-label ${list.complete ? 'success' : 'warning'}`}>{list.complete ? 'Complete' : 'Incomplete'}</span></div>
      {!list.complete && <Feedback error><p>This list is incomplete. Quantities are a lower bound until every ordered variant has a recipe.</p><MissingRecipes missing={list.missing} /></Feedback>}
      {!list.items.length ? <p className="empty-state">Nothing to buy for this period.</p> : <table className="snapshot-table"><thead><tr><th>Ingredient</th><th>To buy</th><th>Physical stock</th><th>Earlier commitments</th><th>This period</th></tr></thead>
        <tbody>{list.items.map(row => <tr key={row.ingredient_id}><th scope="row"><Link to={`/ingredients/${encodeURIComponent(row.ingredient_id)}`}>{row.ingredient_name}</Link></th>
          <td data-label="To buy">{`${row.cumulative_shortage} ${row.base_unit}`}</td><td data-label="Physical stock">{`${row.stock_on_hand} ${row.base_unit}`}</td>
          <td data-label="Earlier commitments">{`${row.earlier_demand} ${row.base_unit}`}</td><td data-label="This period">{`${row.period_demand} ${row.base_unit}`}</td></tr>)}</tbody></table>}
      <p className="estimate-note">{`Calculated ${formatBusinessTime(list.calculated_at, list.timezone)}. To buy is what earlier commitments and this period need beyond physical stock.`}</p>
    </section>}
  </>;
}
