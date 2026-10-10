import {createContext, useContext, useEffect, useRef, useState} from 'react';
import {Outlet, useLocation, useNavigate} from 'react-router-dom';
import {ApiError, type ApiClient} from '../api/client';
import {heldAttempt, rejectedOutright, releaseAttempt} from '../api/pending';
import type {BusinessSettings} from '../api/types';
import {useSession} from '../auth/session';
import {Feedback, Loading} from '../components/ui';
import type {Order} from './types';
import {readOrderOperation} from './operations';
import {operationOrder} from './responses';
import {OrderEditor, orderOperationMarker} from './OrderEditor';
import {ActionDialog, type ActionKind} from './ActionDialog';

type OrdersContext = {client: ApiClient; settings: BusinessSettings; revision: number; blocked: boolean; open: (order?: Order, confirm?: boolean) => void; act: (order: Order, action: ActionKind) => void};
const Context = createContext<OrdersContext | null>(null);
export function useOrders() {const value = useContext(Context); if (!value) throw new Error('Orders context missing.'); return value;}
export function OrderArea({client}: {client: ApiClient}) {
  const {settings, settingsError, checkSession} = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [target, setTarget] = useState<{kind: 'editor'; order?: Order; confirm: boolean} | {kind: 'action'; order: Order; action: ActionKind} | null>(null);
  const [marker, setMarker] = useState(() => sessionStorage.getItem(orderOperationMarker));
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [retryAllowed, setRetryAllowed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [destination, setDestination] = useState<{path: string; returnTo: string} | null>(null);
  const active = useRef(true);
  const controller = useRef(new AbortController());
  useEffect(() => () => {active.current = false; controller.current.abort();}, []);
  useEffect(() => {if (destination && !target) {navigate(destination.path, {state: {returnTo: destination.returnTo}}); setDestination(null);}}, [destination, target, navigate]);
  if (!settings) return settingsError ? <Feedback error>{settingsError}<button className="text-action" onClick={() => void checkSession()}>Retry settings</button></Feedback> : <Loading>Loading settings...</Loading>;
  if (!settings.capabilities.orders) return <><h1>Orders unavailable</h1><Feedback>Reservations are not enabled for this workspace.</Feedback></>;
  if (settings.environment !== 'development' && (settings.environment !== 'live' || !['currency', 'timezone', 'fulfillment', 'delivery', 'tax'].every(key => settings.confirmation[key as keyof typeof settings.confirmation] === true))) {
    return <Feedback error>Business settings require confirmation before live reservations.</Feedback>;
  }
  if (!settings.fulfillment_methods?.length || settings.fulfillment_methods.some(method => !['pickup', 'delivery'].includes(method))
    || !['manual_amount', 'fixed_amount', 'disabled'].includes(settings.delivery_policy?.mode) || settings.tax_policy?.mode !== 'manual_amount'
    || (settings.delivery_policy.mode === 'fixed_amount' && (!Number.isSafeInteger(settings.delivery_policy.fixed_charge_minor) || settings.delivery_policy.fixed_charge_minor! < 0))) {
    return <Feedback error>Reservation settings could not be verified.<button className="text-action" onClick={() => void checkSession()}>Retry settings</button></Feedback>;
  }
  const saved = (order: Order, message = 'Order saved.') => {
    setTarget(null); setMarker(null); setRevision(value => value + 1); setMessage(message);
    const path = `/orders/${encodeURIComponent(order.id)}`;
    if (location.pathname !== path) setDestination({path, returnTo: location.pathname + location.search});
  };
  async function reconcile() {
    if (!marker || checking) return;
    setChecking(true); setRetryAllowed(false);
    try {
      const operation = await readOrderOperation(client, marker, controller.current.signal);
      if (!active.current) return;
      if (operation.state === 'succeeded') {releaseAttempt(orderOperationMarker); saved(operationOrder(operation.result!.body));}
      else if (operation.state === 'rejected') {releaseAttempt(orderOperationMarker); setMarker(null); setMessage(`The earlier save was rejected: ${operation.error!.error.message}`);}
      else setMessage('The earlier save is still processing. Check again before starting another order.');
    } catch (failure) {
      if (!active.current) return;
      // The exact request outlives its editor in memory; without it a missing operation stays an operator matter.
      const retained = failure instanceof ApiError && failure.status === 404 && Boolean(heldAttempt(orderOperationMarker));
      setRetryAllowed(retained);
      setMessage(retained ? 'No save was recorded. You may retry the identical request with its original operation ID.'
        : failure instanceof ApiError && failure.status === 404 ? 'This operation is not recorded. The original draft is no longer available; ask an operator to reconcile it before another submission.' : 'Save status could not be verified. Check again.');
    } finally {if (active.current) setChecking(false);}
  }
  async function retry() {
    const pending = heldAttempt(orderOperationMarker);
    if (!pending || checking) return;
    setChecking(true); setRetryAllowed(false);
    try {
      const order = operationOrder(await client.request(pending.path, {method: pending.method, body: pending.body, operationId: pending.id}));
      if (!active.current) return;
      releaseAttempt(orderOperationMarker); saved(order);
    } catch (failure) {
      if (!active.current) return;
      if (rejectedOutright(failure)) {releaseAttempt(orderOperationMarker); setMarker(null); setMessage(`The earlier save was rejected: ${failure.message}`);}
      else setMessage('Save result unconfirmed. Check its status again.');
    } finally {if (active.current) setChecking(false);}
  }
  const close = (refresh = false) => {setTarget(null); setMarker(sessionStorage.getItem(orderOperationMarker)); if (refresh) setRevision(value => value + 1);};
  return <Context.Provider value={{client, settings, revision, blocked: Boolean(marker), open: (order, confirm = false) => {if (!marker) {setMessage(null); setTarget({kind: 'editor', order, confirm});}}, act: (order, action) => {if (!marker) {setMessage(null); setTarget({kind: 'action', order, action});}}}}>
    {message && <div className="menu-notice"><Feedback>{message}</Feedback></div>}
    {marker && !target && <div className="menu-notice"><Feedback>Earlier order save unresolved. Operation: {marker}<button className="text-action" disabled={checking} onClick={() => void reconcile()}>Check save status</button>{retryAllowed && <button className="text-action" disabled={checking} onClick={() => void retry()}>Retry identical save</button>}</Feedback></div>}
    <Outlet />
    {target?.kind === 'editor' && <OrderEditor client={client} settings={settings} order={target.order} confirmOnly={target.confirm} onClose={close} onSaved={saved} />}
    {target?.kind === 'action' && <ActionDialog client={client} settings={settings} order={target.order} action={target.action} onClose={close} onSaved={saved} />}
  </Context.Provider>;
}
