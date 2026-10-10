import {useCallback, useEffect, useRef, useState} from 'react';
import {Link, useLocation, useParams, useSearchParams} from 'react-router-dom';
import {ArrowLeft, ChevronLeft, ChevronRight, ListFilter, Plus, RotateCw, Search, Printer} from 'lucide-react';
import type {PageResult} from '../api/types';
import {protectedData} from '../auth/protected-data';
import {Feedback, Field, IconButton, Loading} from '../components/ui';
import {formatBusinessTime, formatCalendarDate, formatMoney, statusLabel} from '../lib/format';
import {checkedPage} from '../menu/responses';
import {useOrders} from './OrderArea';
import {checkedDashboard, checkedOrder, checkedSummary} from './responses';
import type {Dashboard, Order, OrderSummary} from './types';
import {Amounts, SnapshotItems, Status} from './presentation';
import {OrderActions} from './OrderActions';
import {Ledger} from './Ledger';
import {LowStock} from '../inventory/InventoryPages';

function useRecord<T>(path: string, validate: (value: unknown) => T) {
  const {client, revision} = useOrders();
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{path: string; value?: T; error?: string}>({path});
  useEffect(() => {
    let active = true; const controller = new AbortController(); setState({path});
    void client.request(path, {signal: controller.signal}).then(value => {const record = validate(value); if (active) setState({path, value: record});}).catch(failure => {if (active) setState({path, error: failure.message});});
    return () => {active = false; controller.abort();};
  }, [client, path, revision, retry, validate]);
  return {...(state.path === path ? state : {path}), retry: () => setRetry(value => value + 1)};
}
function useOrderRecord(id: string) {
  const validate = useCallback((value: unknown) => {const order = checkedOrder(value); if (order.id !== id) throw new Error('The order response does not match this page.'); return order;}, [id]);
  return useRecord<Order>(`/orders/${encodeURIComponent(id)}`, validate);
}
const summaryPage = (value: unknown) => checkedPage(value, checkedSummary);
const activeStatuses = 'pending,confirmed,preparing,ready';
function collectionLink(date: string, collection: 'today' | 'upcoming') {
  const next = new Date(`${date}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  const params = new URLSearchParams(collection === 'today' ? {date_from: date, date_to: date, status: `${activeStatuses},completed`} : {date_from: next.toISOString().slice(0, 10), status: activeStatuses});
  return `/orders?${params}`;
}
function Failure({message, retry}: {message: string; retry: () => void}) {return <Feedback error>{message}<button className="text-action" onClick={retry}><RotateCw size={15} />Retry</button></Feedback>;}
function NewOrder() {const {open, blocked} = useOrders(); return <button className="button primary" disabled={blocked} onClick={() => open()}><Plus size={18} />New order</button>;}
export function SummaryTable({rows, returnTo}: {rows: OrderSummary[]; returnTo: string}) {
  return <table className="order-table"><thead><tr><th>Reference / customer</th><th>Fulfillment</th><th>Preparation</th><th>Payment</th><th>Total / balance</th></tr></thead><tbody>{rows.map(order => <tr key={order.id}>
    <th scope="row"><Link to={`/orders/${encodeURIComponent(order.id)}`} state={{returnTo}} onClick={() => protectedData.set(`orders-scroll:${returnTo}`, window.scrollY)}>{order.reference}</Link><span>{order.customer_name}</span><small>{order.customer_phone}</small></th>
    <td data-label="Fulfillment">{formatBusinessTime(order.fulfillment_at, order.fulfillment_timezone)}<small>{order.fulfillment_method === 'pickup' ? 'Pickup' : 'Delivery'}</small></td>
    <td data-label="Preparation"><Status value={order.status} /></td><td data-label="Payment"><Status value={order.payment_status} /></td><td data-label="Total / balance" className="money">{formatMoney(order.total_minor, order)}<small>Due {formatMoney(order.balance_due_minor, order)}</small>{order.customer_credit_minor > 0 && <small>Credit {formatMoney(order.customer_credit_minor, order)}</small>}</td>
  </tr>)}</tbody></table>;
}
export function OrdersPage() {
  const [params, setParams] = useSearchParams(); const location = useLocation();
  const path = `/orders?${params.toString()}`; const state = useRecord<PageResult<OrderSummary>>(path, summaryPage);
  const route = location.pathname + location.search;
  const restored = useRef<string | null>(null);
  useEffect(() => {if (state.value && restored.current !== route) {const scroll = protectedData.get(`orders-scroll:${route}`); if (typeof scroll === 'number') window.scrollTo(0, scroll); restored.current = route;}}, [route, state.value]);
  function filter(key: string, value: string) {const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); next.delete('page'); setParams(next, {replace: true});}
  return <><div className="page-heading"><h1>Orders</h1><NewOrder /></div><div className="menu-filters order-filters">
    <Field id="order-search" label="Search orders" maxLength={200} value={params.get('q') ?? ''} onChange={e => filter('q', e.target.value)} suffix={<Search className="search-icon" size={18} />} />
    <Field id="order-from" type="date" label="From date" value={params.get('date_from') ?? ''} onChange={e => filter('date_from', e.target.value)} />
    <Field id="order-to" type="date" label="To date" value={params.get('date_to') ?? ''} onChange={e => filter('date_to', e.target.value)} />
    <div className="field"><label htmlFor="order-status">Order status filter</label><select id="order-status" value={params.get('status') ?? ''} onChange={e => filter('status', e.target.value)}><option value="">All statuses</option><option value={activeStatuses}>Active orders</option><option value={`${activeStatuses},completed`}>Not cancelled</option>{['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'].map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></div>
    <div className="field"><label htmlFor="order-sort">Sort orders</label><select id="order-sort" value={params.get('sort') ?? 'fulfillment_asc'} onChange={e => filter('sort', e.target.value)}><option value="fulfillment_asc">Earliest first</option><option value="fulfillment_desc">Latest first</option></select></div>
    <IconButton label="Clear order filters" onClick={() => setParams({}, {replace: true})}><ListFilter size={20} /></IconButton></div>
    {state.error ? <Failure message={state.error} retry={state.retry} /> : !state.value ? <Loading>Loading orders...</Loading> : <><div className="menu-count">{state.value.total} orders</div>{state.value.items.length ? <SummaryTable rows={state.value.items} returnTo={route} /> : <div className="empty-state"><h2>{params.has('q') || params.has('status') || params.has('date_from') || params.has('date_to') ? 'No orders match these filters.' : 'No orders yet.'}</h2></div>}
      <div className="pagination"><span>Page {state.value.page}</span><div><IconButton label="Previous orders page" disabled={state.value.page === 1} onClick={() => {const next = new URLSearchParams(params); next.set('page', String(state.value!.page - 1)); setParams(next);}}><ChevronLeft size={20} /></IconButton>
      <IconButton label="Next orders page" disabled={!state.value.has_next} onClick={() => {const next = new URLSearchParams(params); next.set('page', String(state.value!.page + 1)); setParams(next);}}><ChevronRight size={20} /></IconButton></div></div></>}
  </>;
}
export function OrderDetails() {
  const {id} = useParams(); const location = useLocation();
  const state = useOrderRecord(id ?? '');
  const requested = location.state?.returnTo;
  const returnTo = typeof requested === 'string' && /^\/(orders|dashboard)(\?|$)/.test(requested) && !/[\\\r\n]/.test(requested) ? requested : '/orders';
  return <><Link className="back-link" to={returnTo}><ArrowLeft size={16} />Back to {returnTo.startsWith('/dashboard') ? 'dashboard' : 'orders'}</Link>
    {state.error ? <Failure message={state.error} retry={state.retry} /> : !state.value ? <Loading>Loading order...</Loading> : <>
      <div className="page-heading order-detail-heading"><div><h1>{state.value.reference}</h1><small>Version {state.value.version}</small></div><OrderActions order={state.value} /></div><OrderFacts order={state.value} />
      <section className="page-section"><h2>Items</h2><SnapshotItems items={state.value.items} money={state.value} /><Amounts value={state.value} />{state.value.notes && <p className="order-notes">{state.value.notes}</p>}</section>
      <Ledger order={state.value} />
      <section className="page-section"><h2>Status history</h2><ol className="order-history">{state.value.status_history.map(event => <li key={event.id}><Status value={event.to_status} /><span>{formatBusinessTime(event.changed_at, state.value!.fulfillment.timezone)}<small>{event.actor.display_name}</small>{event.reason && <p>{event.reason}</p>}</span></li>)}</ol></section>
    </>}
  </>;
}
function OrderFacts({order}: {order: Order}) {
  return <dl className="order-facts page-section"><div><dt>Customer</dt><dd>{order.customer.name}<small>{order.customer.phone}</small><small>{order.customer.notes}</small></dd></div>
    <div><dt>Fulfillment</dt><dd>{order.fulfillment.method === 'pickup' ? 'Pickup' : 'Delivery'}<small>{formatBusinessTime(order.fulfillment.fulfillment_at, order.fulfillment.timezone)} ({order.fulfillment.utc_offset})</small><small>{order.fulfillment.timezone}</small><small>{order.fulfillment.address ?? order.fulfillment.pickup_location}</small></dd></div>
    <div><dt>Preparation status</dt><dd><Status value={order.status} /></dd></div><div><dt>Payment status</dt><dd><Status value={order.payment_status} /></dd></div></dl>;
}
export function PrintOrder() {
  const {id} = useParams(); const {blocked} = useOrders(); const location = useLocation();
  const state = useOrderRecord(id ?? '');
  return <><div className="print-toolbar"><Link className="back-link" to={`/orders/${encodeURIComponent(id ?? '')}`} state={location.state}><ArrowLeft size={16} />Back to order</Link><IconButton label="Print summary" disabled={!state.value || blocked} onClick={() => window.print()}><Printer size={20} /></IconButton></div>
    {state.error ? <Failure message={state.error} retry={state.retry} /> : !state.value ? <Loading>Loading order...</Loading> : <section aria-label="Printable order summary" className="print-summary"><div className="page-heading"><div><h1>{state.value.reference}</h1><small>Version {state.value.version}</small></div></div><OrderFacts order={state.value} /><section className="page-section"><h2>Items</h2><SnapshotItems items={state.value.items} money={state.value} /><Amounts value={state.value} />{state.value.notes && <p className="order-notes">{state.value.notes}</p>}{state.value.status === 'cancelled' && <p>Cancellation: {state.value.status_history.find(event => event.to_status === 'cancelled')?.reason}</p>}</section></section>}
  </>;
}
export function DashboardPage() {
  const {client, settings} = useOrders();
  const [params, setParams] = useSearchParams(); const location = useLocation(); const date = params.get('date');
  const state = useRecord<Dashboard>(`/dashboard${date ? `?date=${encodeURIComponent(date)}` : ''}`, checkedDashboard);
  return <><div className="page-heading"><h1>Dashboard</h1><NewOrder /></div><div className="menu-filters"><Field id="dashboard-date" label="Dashboard date" type="date" value={date ?? state.value?.business_date ?? ''} onChange={e => setParams(e.target.value ? {date: e.target.value} : {}, {replace: true})} />{state.value && <small>{state.value.timezone}</small>}</div>
    {state.error ? <Failure message={state.error} retry={state.retry} /> : !state.value ? <Loading>Loading dashboard...</Loading> : <>{(['today', 'upcoming'] as const).map(collection => <section className="page-section" key={collection}><div className="section-heading"><h2>{collection === 'today' ? "Today's orders" : 'Upcoming orders'}</h2><small>{collection === 'today' ? formatCalendarDate(state.value!.business_date) : `After ${formatCalendarDate(state.value!.business_date)}`}</small></div>
      {state.value![collection].items.length ? <SummaryTable rows={state.value![collection].items} returnTo={location.pathname + location.search} /> : <p className="empty-state">{collection === 'today' ? 'No orders for this date.' : 'No upcoming orders.'}</p>}
      {state.value![collection].has_next && <Link to={collectionLink(state.value!.business_date, collection)}>{collection === 'today' ? 'View all orders for this date' : 'View all upcoming orders'}</Link>}
    </section>)}</>}
    <LowStock client={client} settings={settings} />
  </>;
}
