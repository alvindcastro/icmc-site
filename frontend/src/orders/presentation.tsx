import {formatBusinessTime, formatMoney, statusLabel} from '../lib/format';
import type {Order, Quote, SnapshotLine, Totals} from './types';
import {sellingLabel} from '../menu/model';
export function Amounts({value}: {value: Totals}) {
  return <dl className="order-totals">{(['subtotal_minor', 'delivery_charge_minor', 'tax_minor', 'total_minor', 'net_paid_minor', 'balance_due_minor', 'customer_credit_minor'] as const).map(key => <div key={key}>
    <dt>{{subtotal_minor: 'Subtotal', delivery_charge_minor: 'Delivery', tax_minor: 'Tax', total_minor: 'Total', net_paid_minor: 'Net paid', balance_due_minor: 'Balance due', customer_credit_minor: 'Customer credit'}[key]}</dt>
    <dd className="money">{formatMoney(value[key], value)}</dd></div>)}</dl>;
}
export function SnapshotItems({items, money}: {items: SnapshotLine[]; money: {currency: string; minor_digits: number}}) {
  return <table className="snapshot-table"><thead><tr><th>Item</th><th>Quantity</th><th>Unit price</th><th>Line total</th></tr></thead><tbody>{items.map((item, index) => <tr key={index}>
    <th scope="row">{item.food_name}<small>{item.variant_label}</small>{item.preparation_notes && <p className="item-note">{item.preparation_notes}</p>}</th>
    <td data-label="Quantity">{item.quantity} {item.selling_unit}{item.quantity === 1 ? '' : 's'}{item.package_contents && ` / ${item.package_contents.quantity} pieces`}{item.prepared_quantity !== null && <small>{`${item.prepared_quantity} prepared / ${item.remaining_quantity} remaining`}</small>}</td>
    <td data-label="Unit price">{formatMoney(item.unit_price_minor, money)}<small>{sellingLabel(item.selling_unit, item.package_contents)}</small></td><td data-label="Line total" className="money">{formatMoney(item.line_total_minor, money)}</td>
  </tr>)}</tbody></table>;
}
export function OrderReview({value, customer, notes}: {value: Quote | Order; customer: Order['customer']; notes: string}) {
  return <section aria-label="Order review" className="order-review"><h3>Order review</h3><dl className="order-facts"><div><dt>Customer</dt><dd>{customer.name}<small>{customer.phone}</small>{customer.notes && <small>{customer.notes}</small>}</dd></div>
    <div><dt>Fulfillment</dt><dd>{value.fulfillment.method === 'pickup' ? 'Pickup' : 'Delivery'}<small>{formatBusinessTime(value.fulfillment.fulfillment_at, value.fulfillment.timezone)} ({value.fulfillment.utc_offset})</small><small>{value.fulfillment.timezone}</small><small>{value.fulfillment.address ?? value.fulfillment.pickup_location}</small></dd></div></dl>
    <SnapshotItems items={'lines' in value ? value.lines : value.items} money={value} /><Amounts value={value} />{notes && <p className="order-notes">{notes}</p>}
  </section>;
}
export function Status({value}: {value: string}) {return <span className={`status-label ${['confirmed', 'completed', 'paid'].includes(value) ? 'success' : ['pending', 'partial', 'credit_due'].includes(value) ? 'warning' : 'neutral'}`}>{statusLabel(value)}</span>;}
