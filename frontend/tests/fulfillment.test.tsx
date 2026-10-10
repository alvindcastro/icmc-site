import {act, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter} from 'react-router-dom';
import {describe, expect, it, vi} from 'vitest';
import {App} from '../src/App';
import {createApiClient} from '../src/api/client';
import type {FetchTransport} from '../src/api/types';
import {financialApi} from './phase4-helpers';
import {orderOperationMarker} from '../src/orders/OrderEditor';
async function start(path: string, transport: FetchTransport) {
  const client = createApiClient({baseUrl: '/api/v1', transport}); const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[path]}><App client={client} mode="fixtures" /></MemoryRouter>);
  await user.type(await screen.findByLabelText('Token'), 'local-admin-token'); await user.click(screen.getByRole('button', {name: 'Sign in'}));
  await screen.findByRole('heading', {name: 'DEV-0001'}); return {client, user};
}
async function payForm(user: ReturnType<typeof userEvent.setup>, amount = '180') {
  await user.click(screen.getByRole('button', {name: 'Record payment'})); await screen.findByLabelText('Payment amount');
  await user.clear(screen.getByLabelText('Payment amount')); await user.type(screen.getByLabelText('Payment amount'), amount);
  await user.clear(screen.getByLabelText('Payment date')); await user.type(screen.getByLabelText('Payment date'), '2026-10-07');
  await user.type(screen.getByLabelText('Payment reference'), 'Deposit receipt'); await user.type(screen.getByLabelText('Payment note'), 'Contacted customer');
  await user.click(screen.getByRole('button', {name: 'Review payment'})); await screen.findByRole('region', {name: 'Payment review'});
}
describe('fulfillment and financial workflow', () => {
  it('reviews each next status, requires manual ready/completion attestation, and keeps an unpaid completion', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const {user} = await start(`/orders/${order.id}`, fixture.fetch);
    await user.click(screen.getByRole('button', {name: 'Start preparing'})); await user.click(screen.getByRole('button', {name: 'Confirm preparing'}));
    await screen.findByText('Version 2'); expect(screen.getByRole('button', {name: 'Edit order'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Mark ready'})); const ready = screen.getByRole('button', {name: 'Confirm ready'}); expect(ready).toBeDisabled();
    await user.click(screen.getByLabelText('Food is ready for pickup or delivery')); await user.click(ready); await screen.findByText('Version 3');
    await user.click(screen.getByRole('button', {name: 'Complete order'})); await user.click(screen.getByLabelText('Order has been fulfilled')); await user.click(screen.getByRole('button', {name: 'Confirm completion'}));
    await screen.findByText('Version 4'); expect(screen.getAllByText('Completed').length).toBeGreaterThan(0); expect(screen.getByText('Unpaid')).toBeVisible();
    expect(screen.getByRole('button', {name: 'Cancel order'})).toBeDisabled(); expect(screen.getByText('Completed or cancelled orders cannot be cancelled.')).toBeVisible();
  });
  it('validates, reviews and records a deposit; refreshes detail, list and dashboard balances', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const {user} = await start(`/orders/${order.id}`, fixture.fetch);
    expect(screen.getByText('No payments or refunds recorded.')).toBeVisible(); await user.click(screen.getByRole('button', {name: 'Record payment'}));
    await user.click(screen.getByRole('button', {name: 'Review payment'})); expect(screen.getByLabelText('Payment amount')).toHaveFocus();
    await user.type(screen.getByLabelText('Payment amount'), '215.01'); await user.click(screen.getByRole('button', {name: 'Review payment'}));
    expect(screen.getByText('Amount must not exceed $215.00.')).toBeVisible();
    await user.clear(screen.getByLabelText('Payment amount')); await user.type(screen.getByLabelText('Payment amount'), '180');
    await user.clear(screen.getByLabelText('Payment date')); await user.type(screen.getByLabelText('Payment date'), '2026-10-07');
    await user.selectOptions(screen.getByLabelText('Payment method'), 'bank_transfer'); await user.type(screen.getByLabelText('Payment reference'), 'Transfer ABC');
    await user.click(screen.getByRole('button', {name: 'Review payment'})); expect(within(await screen.findByRole('region', {name: 'Payment review'})).getByText('$180.00')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Confirm payment'})); await screen.findByText('Version 2');
    const ledger = screen.getByRole('region', {name: 'Payments and refunds'}); expect(within(ledger).getByText('Transfer ABC')).toBeVisible(); expect(screen.getByText('Partial')).toBeVisible();
    await user.click(screen.getByRole('link', {name: 'Back to orders'})); expect(await screen.findByText('Due $35.00')).toBeVisible();
    await user.click(screen.getByRole('link', {name: 'Dashboard'})); await user.clear(await screen.findByLabelText('Dashboard date')); await user.type(screen.getByLabelText('Dashboard date'), '2026-10-10');
    expect(await screen.findByText('Due $35.00')).toBeVisible();
  });
  it('cancels with a required reason while retaining payments, then confirms a full refund as a separate entry', async () => {
    const {api, fixture, order, payment} = await financialApi(); await payment(); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const {user} = await start(`/orders/${order.id}`, fixture.fetch); await user.click(screen.getByRole('button', {name: 'Cancel order'}));
    await user.click(screen.getByRole('button', {name: 'Confirm cancellation'})); expect(screen.getByLabelText('Cancellation reason')).toHaveFocus();
    await user.type(screen.getByLabelText('Cancellation reason'), 'Customer changed plans'); await user.click(screen.getByRole('button', {name: 'Confirm cancellation'}));
    await screen.findByText('Version 3'); expect(screen.getByText('Customer changed plans')).toBeVisible(); expect(screen.getByText('Credit due')).toBeVisible();
    expect(screen.getByRole('button', {name: 'Record payment'})).toBeDisabled(); await user.click(screen.getByRole('button', {name: 'Record refund'}));
    await user.type(screen.getByLabelText('Refund amount'), '180'); await user.clear(screen.getByLabelText('Refund date')); await user.type(screen.getByLabelText('Refund date'), '2026-10-07');
    await user.click(screen.getByRole('button', {name: 'Review refund'})); expect(screen.getByLabelText('Refund reason')).toHaveFocus();
    await user.type(screen.getByLabelText('Refund reason'), 'Cancellation refund'); await user.click(screen.getByRole('button', {name: 'Review refund'}));
    await user.click(await screen.findByRole('button', {name: 'Confirm refund'})); await screen.findByText('Version 4');
    expect(screen.getByText('Paid')).toBeVisible(); const ledger = screen.getByRole('region', {name: 'Payments and refunds'});
    expect(within(ledger).getByText('Payment')).toBeVisible(); expect(within(ledger).getByText('Refund')).toBeVisible(); expect(within(ledger).getByText('Cancellation refund')).toBeVisible();
    expect(within(ledger).getAllByText('$180.00')).toHaveLength(2);
  });
  it('preserves financial inputs on conflict and requires latest-record review before a corrected submission', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const {client, user} = await start(`/orders/${order.id}`, fixture.fetch); await payForm(user, '100');
    await client.request(`/orders/${order.id}/payments`, {method: 'POST', operationId: 'other-staff-pay', body: {expected_version: 1, amount_minor: 21400, paid_on: '2026-10-07', method: 'cash'}});
    await user.click(screen.getByRole('button', {name: 'Confirm payment'})); expect(await screen.findByText('Latest saved order')).toBeVisible();
    expect(screen.getByLabelText('Payment amount')).toHaveValue('100'); expect(screen.getByLabelText('Payment reference')).toHaveValue('Deposit receipt');
    await user.click(screen.getByRole('button', {name: 'Use reviewed order version'})); await user.click(screen.getByRole('button', {name: 'Review payment'}));
    expect(screen.getByText('Amount must not exceed $1.00.')).toBeVisible(); await user.clear(screen.getByLabelText('Payment amount')); await user.type(screen.getByLabelText('Payment amount'), '1');
    await user.click(screen.getByRole('button', {name: 'Review payment'})); await user.click(await screen.findByRole('button', {name: 'Confirm payment'})); await screen.findByText('Version 3'); expect(screen.getByText('Paid')).toBeVisible();
  });
  it('reconciles a committed uncertain deposit without repeating the payment', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {const response = await fixture.fetch(input, init); if (String(input).endsWith('/payments') && init?.method === 'POST') throw new TypeError('lost committed response'); return response;});
    const {user} = await start(`/orders/${order.id}`, transport); await payForm(user); await user.click(screen.getByRole('button', {name: 'Confirm payment'}));
    await user.click(await screen.findByRole('button', {name: 'Check transaction status'})); await screen.findByText('Version 2');
    expect(transport.mock.calls.filter(([input, init]) => String(input).endsWith('/payments') && init?.method === 'POST')).toHaveLength(1); expect(sessionStorage.length).toBe(0);
  });
  it('keeps an unrecorded refund attempt frozen and offers only an exact same-key/body retry', async () => {
    const {api, fixture, order, payment} = await financialApi(); await payment(); await api.request('/auth/sign-out', {method: 'POST', body: {}}); let lost = true;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {if (lost && String(input).endsWith('/refunds') && init?.method === 'POST') {lost = false; throw new TypeError('lost request');} return fixture.fetch(input, init);});
    const {user} = await start(`/orders/${order.id}`, transport); await user.click(screen.getByRole('button', {name: 'Record refund'}));
    await user.type(screen.getByLabelText('Refund amount'), '30'); await user.clear(screen.getByLabelText('Refund date')); await user.type(screen.getByLabelText('Refund date'), '2026-10-07'); await user.type(screen.getByLabelText('Refund reason'), 'Reason');
    await user.click(screen.getByRole('button', {name: 'Review refund'})); await user.click(await screen.findByRole('button', {name: 'Confirm refund'}));
    expect(await screen.findByRole('button', {name: 'Check transaction status'})).toBeVisible(); expect(screen.getByRole('button', {name: 'Confirm refund'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check transaction status'})); await user.click(await screen.findByRole('button', {name: 'Retry identical transaction'})); await screen.findByText('Version 3');
    const calls = transport.mock.calls.filter(([input, init]) => String(input).endsWith('/refunds') && init?.method === 'POST'); expect(calls).toHaveLength(2);
    expect(calls[0][1]?.body).toBe(calls[1][1]?.body); expect(new Headers(calls[0][1]?.headers).get('Idempotency-Key')).toBe(new Headers(calls[1][1]?.headers).get('Idempotency-Key'));
  });
  it('uses a fresh snapshot-only printable route, validates protected return and invokes printing', async () => {
    const {api, fixture, order, payment} = await financialApi(); await payment(); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const print = vi.spyOn(window, 'print').mockImplementation(() => {}); const {user} = await start(`/orders/${order.id}/print`, fixture.fetch);
    expect(screen.getByRole('region', {name: 'Printable order summary'})).toBeVisible(); expect(screen.getAllByText('$35.00').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', {name: 'Edit order'})).not.toBeInTheDocument(); await user.click(screen.getByRole('button', {name: 'Print summary'})); expect(print).toHaveBeenCalledOnce();
  });
  it('refuses to print a mismatched order response and recovers with a fresh read', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}}); let mismatch = true;
    const client = createApiClient({baseUrl: '/api/v1', transport: async (input, init) => {
      const response = await fixture.fetch(input, init); if (String(input).endsWith(`/orders/${order.id}`) && mismatch) {const saved = await response.json(); saved.id = 'different-order'; return new Response(JSON.stringify(saved));} return response;
    }}); const user = userEvent.setup(); render(<MemoryRouter initialEntries={[`/orders/${order.id}/print`]}><App client={client} mode="fixtures" /></MemoryRouter>);
    await user.type(await screen.findByLabelText('Token'), 'local-admin-token'); await user.click(screen.getByRole('button', {name: 'Sign in'}));
    expect(await screen.findByText('The order response does not match this page.')).toBeVisible(); expect(screen.getByRole('button', {name: 'Print summary'})).toBeDisabled(); expect(screen.queryByRole('region', {name: 'Printable order summary'})).not.toBeInTheDocument();
    mismatch = false; await user.click(screen.getByRole('button', {name: 'Retry'})); await screen.findByRole('region', {name: 'Printable order summary'}); expect(screen.getByRole('button', {name: 'Print summary'})).toBeEnabled();
  });
  it('preserves filtered-list return through the print view', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const client = createApiClient({baseUrl: '/api/v1', transport: fixture.fetch}); const user = userEvent.setup(); render(<MemoryRouter initialEntries={['/orders?q=Sample&status=confirmed']}><App client={client} mode="fixtures" /></MemoryRouter>);
    await user.type(await screen.findByLabelText('Token'), 'local-admin-token'); await user.click(screen.getByRole('button', {name: 'Sign in'})); await user.click(await screen.findByRole('link', {name: 'DEV-0001'}));
    await user.click(await screen.findByRole('link', {name: 'Print order'})); await user.click(await screen.findByRole('link', {name: 'Back to order'})); await screen.findByRole('heading', {name: 'DEV-0001'});
    expect(screen.getByRole('link', {name: 'Back to orders'})).toHaveAttribute('href', '/orders?q=Sample&status=confirmed'); expect(order).toBeTruthy();
  });
  it('hides financial controls when payment capability is disabled and does not manufacture refund limits', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const {user} = await start(`/orders/${order.id}`, async (input, init) => {const response = await fixture.fetch(input, init); if (String(input).endsWith('/settings')) {const data = await response.json(); data.capabilities.payments = false; return new Response(JSON.stringify(data));} return response;});
    expect(screen.queryByRole('button', {name: 'Record payment'})).not.toBeInTheDocument(); expect(screen.queryByRole('button', {name: 'Record refund'})).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Start preparing'})).toBeEnabled(); expect(user).toBeTruthy();
  });
  it('clears a sensitive payment draft on expiry and reconciles only the UUID after re-login', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {const response = await fixture.fetch(input, init); if (String(input).endsWith('/payments') && init?.method === 'POST') {fixture.expire(); throw new TypeError('lost committed payment');} return response;});
    const {client, user} = await start(`/orders/${order.id}`, transport); await payForm(user); await user.click(screen.getByRole('button', {name: 'Confirm payment'})); await screen.findByRole('button', {name: 'Check transaction status'});
    await act(async () => {await expect(client.request('/auth/session')).rejects.toMatchObject({status: 401});}); await screen.findByRole('button', {name: 'Sign in'});
    expect(screen.queryByText('Deposit receipt')).not.toBeInTheDocument(); expect(sessionStorage.length).toBe(1); expect(sessionStorage.getItem(orderOperationMarker)).toBeTruthy();
    await user.type(screen.getByLabelText('Token'), 'local-admin-token'); await user.click(screen.getByRole('button', {name: 'Sign in'})); await screen.findByRole('button', {name: 'Record payment'});
    expect(screen.getByRole('button', {name: 'Record payment'})).toBeDisabled(); await user.click(screen.getByRole('button', {name: 'Check save status'})); await screen.findByText('Version 2');
    await waitFor(() => expect(screen.getByRole('button', {name: 'Record payment'})).toBeEnabled()); expect(transport.mock.calls.filter(([input, init]) => String(input).endsWith('/payments') && init?.method === 'POST')).toHaveLength(1);
  });
  it('keeps an unrecorded payment retryable with its exact key and body after its dialog is closed', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}}); let lost = true;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {if (lost && String(input).endsWith('/payments') && init?.method === 'POST') {lost = false; throw new TypeError('lost request');} return fixture.fetch(input, init);});
    const {user} = await start(`/orders/${order.id}`, transport); await payForm(user); await user.click(screen.getByRole('button', {name: 'Confirm payment'}));
    await screen.findByRole('button', {name: 'Check transaction status'}); await user.keyboard('{Escape}'); expect(screen.getByText(/still unresolved/)).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Discard changes'})); expect(screen.getByRole('button', {name: 'Record payment'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check save status'})); await user.click(await screen.findByRole('button', {name: 'Retry identical save'})); await screen.findByText('Version 2');
    const posts = transport.mock.calls.filter(([input, init]) => String(input).endsWith('/payments') && init?.method === 'POST');
    expect(posts).toHaveLength(2); expect(posts[1][1]?.body).toBe(posts[0][1]?.body); expect(new Headers(posts[1][1]?.headers).get('Idempotency-Key')).toBe(new Headers(posts[0][1]?.headers).get('Idempotency-Key')); expect(sessionStorage.length).toBe(0);
  });
});
