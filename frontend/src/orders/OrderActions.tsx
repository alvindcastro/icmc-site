import {Check, ChefHat, CircleDollarSign, CookingPot, Flag, Pencil, Printer, Undo2, X} from 'lucide-react';
import {Link, useLocation} from 'react-router-dom';
import {useSession} from '../auth/session';
import {Feedback} from '../components/ui';
import {preparationEnabled} from '../preparation/model';
import {useOrders} from './OrderArea';
import {actionPermission, type ActionKind} from './ActionDialog';
import type {Order} from './types';

export function OrderActions({order}: {order: Order}) {
  const {open, act, blocked, settings} = useOrders();
  const {loadSettings} = useSession();
  const location = useLocation();
  const next = ({confirmed: 'preparing', preparing: 'ready', ready: 'completed'} as const)[order.status as 'confirmed' | 'preparing' | 'ready'];
  const moneyReady = Array.isArray(settings.payment_methods) && settings.payment_methods.length > 0 && settings.payment_methods.every(method => ['cash', 'bank_transfer', 'other'].includes(method));
  function command(action: ActionKind, label: string, icon: React.ReactNode) {
    const permission = order.permitted_actions[actionPermission[action]];
    return <div className="order-command"><button className={`button ${action === 'cancel' ? 'secondary' : 'primary'}`} disabled={blocked || !permission.allowed || ((action === 'payment' || action === 'refund') && !moneyReady)} title={permission.reason ?? undefined} onClick={() => act(order, action)}>{icon}{label}</button>{!permission.allowed && <small>{permission.reason}</small>}</div>;
  }
  return <div className="order-actions">
    <div className="order-command"><button className="button secondary" disabled={blocked || !order.permitted_actions.edit.allowed} title={order.permitted_actions.edit.reason ?? undefined} onClick={() => open(order)}><Pencil size={17} />Edit order</button>{!order.permitted_actions.edit.allowed && <small>{order.permitted_actions.edit.reason}</small>}</div>
    {order.status === 'pending' && <div className="order-command"><button className="button primary" disabled={blocked || !order.permitted_actions.confirm.allowed} onClick={() => open(order, true)}><Check size={17} />Review confirmation</button>{!order.permitted_actions.confirm.allowed && <small>{order.permitted_actions.confirm.reason}</small>}</div>}
    {next && command(next, next === 'preparing' ? 'Start preparing' : next === 'ready' ? 'Mark ready' : 'Complete order', next === 'preparing' ? <CookingPot size={17} /> : next === 'ready' ? <Check size={17} /> : <Flag size={17} />)}
    {preparationEnabled(settings) && order.permitted_actions.record_preparation.allowed && <div className="order-command"><Link className="button secondary" to={`/planning/prepare?${new URLSearchParams({date_from: order.fulfillment.local_date, date_to: order.fulfillment.local_date})}`}><ChefHat size={17} />Record preparation</Link></div>}
    {command('cancel', 'Cancel order', <X size={17} />)}
    {settings.capabilities.payments && <>{command('payment', 'Record payment', <CircleDollarSign size={17} />)}{command('refund', 'Record refund', <Undo2 size={17} />)}{!moneyReady && <Feedback error>Payment settings could not be verified.<button className="text-action" onClick={() => void loadSettings()}>Retry payment settings</button></Feedback>}</>}
    <Link className="icon-button" aria-label="Print order" title="Print order" to={`/orders/${encodeURIComponent(order.id)}/print`} state={location.state}><Printer size={20} /></Link>
  </div>;
}
