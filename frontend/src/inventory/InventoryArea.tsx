import {createContext, useContext, useEffect, useRef, useState} from 'react';
import {Outlet, useLocation, useNavigate} from 'react-router-dom';
import {ApiError, type ApiClient} from '../api/client';
import {heldAttempt, rejectedOutright, releaseAttempt} from '../api/pending';
import type {BusinessSettings} from '../api/types';
import {useSession} from '../auth/session';
import {Feedback, Loading} from '../components/ui';
import type {InventoryResult} from './types';
import {readInventoryOperation} from './operations';
import {checkedInventoryResult} from './responses';
import {InventoryEditor, inventoryOperationMarker, type EditorTarget} from './InventoryEditor';

const Context = createContext<{client: ApiClient; settings: BusinessSettings; revision: number; blocked: boolean; open: (target: EditorTarget) => void} | null>(null);
export function useInventory() {const value = useContext(Context); if (!value) throw new Error('Inventory context missing.'); return value;}
export function InventoryArea({client}: {client: ApiClient}) {
  const {settings, settingsError, loadSettings} = useSession(), location = useLocation(), navigate = useNavigate();
  const [target, setTarget] = useState<EditorTarget | null>(null), [marker, setMarker] = useState(() => sessionStorage.getItem(inventoryOperationMarker));
  const [message, setMessage] = useState(''), [revision, setRevision] = useState(0), [checking, setChecking] = useState(false), [retryAllowed, setRetryAllowed] = useState(false);
  const [destination, setDestination] = useState<string | null>(null), active = useRef(true), controller = useRef(new AbortController());
  useEffect(() => {active.current = true; controller.current = new AbortController(); return () => {active.current = false; controller.current.abort();};}, []);
  useEffect(() => {if (destination && !target) {navigate(destination, {state: {returnTo: location.pathname + location.search}}); setDestination(null);}}, [destination, target, navigate, location.pathname, location.search]);
  const saved = (result: InventoryResult) => {
    releaseAttempt(inventoryOperationMarker); setTarget(null); setMarker(null); setRevision(value => value + 1);
    const receipt = 'purchase' in result, item = receipt ? result.purchase : 'ingredient' in result ? result.ingredient : result;
    setMessage(receipt ? 'Purchase saved.' : 'movement' in result ? 'Stock movement saved.' : 'Ingredient saved.');
    const next = `/${receipt ? 'purchases' : 'ingredients'}/${encodeURIComponent(item.id)}`; if (location.pathname !== next) setDestination(next);
  };
  async function reconcile() {
    if (!marker || checking) return; setChecking(true); setRetryAllowed(false);
    try {
      const operation = await readInventoryOperation(client, marker, controller.current.signal); if (!active.current) return;
      if (operation.state === 'succeeded') saved(operation.result!.body);
      else if (operation.state === 'rejected') {releaseAttempt(inventoryOperationMarker); setMarker(null); setMessage(`Earlier save rejected: ${operation.error!.error.message}`);}
      else setMessage('The earlier save is still processing. Check again before another submission.');
    } catch (error) {
      if (!active.current) return;
      // The exact request outlives its editor in memory; without it a missing operation stays an operator matter.
      const retained = error instanceof ApiError && error.status === 404 && Boolean(heldAttempt(inventoryOperationMarker)); setRetryAllowed(retained);
      setMessage(retained ? 'No operation recorded. Only the exact original submission may be retried.'
        : error instanceof ApiError && error.status === 404 ? 'This operation is not recorded. The original draft is no longer available; ask an operator to reconcile it before another submission.' : 'Save status could not be verified. Check again.');
    } finally {if (active.current) setChecking(false);}
  }
  async function retry() {
    const pending = heldAttempt(inventoryOperationMarker); if (!pending || checking) return; setChecking(true); setRetryAllowed(false);
    try {
      const result = checkedInventoryResult(await client.request(pending.path, {method: pending.method, body: pending.body, operationId: pending.id})); if (!active.current) return;
      saved(result);
    } catch (error) {
      if (!active.current) return;
      if (rejectedOutright(error)) {releaseAttempt(inventoryOperationMarker); setMarker(null); setMessage(`Earlier save rejected: ${error.message}`);}
      else setMessage('Save result unconfirmed. Check its status again.');
    } finally {if (active.current) setChecking(false);}
  }
  if (!settings) return settingsError ? <Feedback error>{settingsError}<button className="text-action" onClick={() => void loadSettings()}>Retry settings</button></Feedback> : <Loading>Loading settings...</Loading>;
  const purchases = location.pathname.startsWith('/purchases');
  if (!settings.capabilities.inventory || purchases && !settings.capabilities.purchases) return <><h1>{purchases ? 'Purchases' : 'Ingredients'} unavailable</h1><Feedback>Inventory workflow is not enabled for this workspace.</Feedback></>;
  if (settings.environment !== 'development' && (settings.environment !== 'live' || !settings.confirmation.currency || !settings.confirmation.timezone)) return <><h1>{purchases ? 'Purchases' : 'Ingredients'}</h1><Feedback error>Business currency and timezone require confirmation before live inventory changes.</Feedback></>;
  return <Context.Provider value={{client, settings, revision, blocked: Boolean(marker), open: next => {if (!marker) {setMessage(''); setTarget(next);}}}}>
    {message && <Feedback>{message}</Feedback>}
    {marker && !target && <Feedback>Earlier inventory save unresolved. Operation: {marker}<button className="text-action" disabled={checking} onClick={() => void reconcile()}>Check save status</button>{retryAllowed && <button className="text-action" disabled={checking} onClick={() => void retry()}>Retry original save</button>}</Feedback>}
    <Outlet />{target && <InventoryEditor target={target} onSaved={saved} onClose={() => {setTarget(null); setMarker(sessionStorage.getItem(inventoryOperationMarker));}} />}
  </Context.Provider>;
}
