import {formatBusinessTime, formatCalendarDate, formatMoney, paymentMethodLabel} from '../lib/format';
import type {Order} from './types';

export function Ledger({order}: {order: Order}) {
  return <section className="page-section" aria-label="Payments and refunds"><h2>Payments and refunds</h2>{!order.ledger.length ? <p>No payments or refunds recorded.</p> : <table className="ledger-table"><thead><tr><th>Entry / date</th><th>Amount</th><th>Method / reference</th><th>Notes / audit</th></tr></thead><tbody>{order.ledger.map(item => <tr key={item.id}>
    <th scope="row">{item.type === 'payment' ? 'Payment' : 'Refund'}<small>{formatCalendarDate(item.business_date)}</small>{item.payment_id && <small>Original payment: {order.ledger.find(payment => payment.id === item.payment_id)?.reference || item.payment_id}</small>}</th>
    <td data-label="Amount" className="money">{formatMoney(item.amount_minor, order)}</td><td data-label="Method / reference">{paymentMethodLabel(item.method)}{item.reference && <small>{item.reference}</small>}</td>
    <td data-label="Notes / audit">{item.reason && <p>{item.reason}</p>}{item.note && <p>{item.note}</p>}<small>{item.recorded_by.display_name}</small><small>{formatBusinessTime(item.recorded_at, order.fulfillment.timezone)}</small></td>
  </tr>)}</tbody></table>}</section>;
}
