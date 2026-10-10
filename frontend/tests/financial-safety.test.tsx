import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter} from 'react-router-dom';
import {describe, expect, it, vi} from 'vitest';
import {App} from '../src/App';
import {createApiClient} from '../src/api/client';
import type {FetchTransport} from '../src/api/types';
import {orderOperationMarker} from '../src/orders/OrderEditor';
import {financialApi} from './phase4-helpers';

async function start(id: string, transport: FetchTransport) {
  const client = createApiClient({baseUrl: '/api/v1', transport}); const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[`/orders/${id}`]}><App client={client} mode="fixtures" /></MemoryRouter>);
  await user.type(await screen.findByLabelText('Token'), 'local-admin-token'); await user.click(screen.getByRole('button', {name: 'Sign in'}));
  await screen.findByRole('heading', {name: 'DEV-0001'}); return {client, user};
}
async function review(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', {name: 'Record payment'})); await user.type(screen.getByLabelText('Payment amount'), '180');
  await user.clear(screen.getByLabelText('Payment date')); await user.type(screen.getByLabelText('Payment date'), '2026-10-07');
  await user.type(screen.getByLabelText('Payment reference'), 'Retained receipt'); await user.click(screen.getByRole('button', {name: 'Review payment'}));
  await screen.findByRole('button', {name: 'Confirm payment'});
}

describe('financial safety boundaries', () => {
  it.each([undefined, null, [], ['card']])('fails closed on incomplete payment methods %j and reloads settings explicitly', async methods => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}}); let malformed = true;
    const {user} = await start(order.id, async (input, init) => {
      const response = await fixture.fetch(input, init); if (malformed && String(input).endsWith('/settings')) {const settings = await response.json(); settings.payment_methods = methods; return new Response(JSON.stringify(settings));} return response;
    });
    expect(screen.getByText('Payment settings could not be verified.')).toBeVisible(); expect(screen.getByRole('button', {name: 'Record payment'})).toBeDisabled(); expect(screen.getByRole('button', {name: 'Start preparing'})).toBeEnabled();
    malformed = false; await user.click(screen.getByRole('button', {name: 'Retry payment settings'})); await waitFor(() => expect(screen.getByRole('button', {name: 'Record payment'})).toBeEnabled());
  });
  it('focuses the confirmation command for a preparation start', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}}); const {user} = await start(order.id, fixture.fetch);
    await user.click(screen.getByRole('button', {name: 'Start preparing'})); expect(screen.getByRole('button', {name: 'Confirm preparing'})).toHaveFocus();
  });
  it('focuses amount on open, protects date/method-only edits and restores the opener', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const {user} = await start(order.id, fixture.fetch); const opener = screen.getByRole('button', {name: 'Record payment'}); await user.click(opener);
    expect(screen.getByRole('option', {name: 'Bank transfer'})).toBeInTheDocument();
    expect(screen.getByLabelText('Payment amount')).toHaveFocus(); await waitFor(() => expect(screen.getByLabelText('Payment date')).not.toHaveValue(''));
    await user.selectOptions(screen.getByLabelText('Payment method'), 'bank_transfer'); await user.clear(screen.getByLabelText('Payment date')); await user.type(screen.getByLabelText('Payment date'), '2026-10-08');
    await user.keyboard('{Escape}'); expect(screen.getByRole('heading', {name: 'Discard changes?'})).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Keep editing'})); expect(screen.getByLabelText('Payment date')).toHaveValue('2026-10-08');
    await user.keyboard('{Escape}'); await user.click(screen.getByRole('button', {name: 'Discard changes'})); expect(opener).toHaveFocus();
  });
  it.each(['operation', 'version', 'amount'])('freezes a mismatched %s response until read-only reconciliation', async kind => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const {user} = await start(order.id, async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (String(input).endsWith('/payments') && response.ok) {
        const result = await response.json(); if (kind === 'version') result.order.version = 1;
        else if (kind === 'operation') {result.entry.operation_id = 'wrong-key'; result.order.ledger[0].operation_id = 'wrong-key';}
        else result.entry.amount_minor = 17900;
        return new Response(JSON.stringify(result), {status: 201});
      } return response;
    });
    await review(user); await user.click(screen.getByRole('button', {name: 'Confirm payment'}));
    expect(await screen.findByRole('button', {name: 'Check transaction status'})).toBeVisible(); expect(screen.getByRole('button', {name: 'Confirm payment'})).toBeDisabled();
    expect(sessionStorage.length).toBe(1); await user.click(screen.getByRole('button', {name: 'Check transaction status'})); await screen.findByText('Version 2'); expect(sessionStorage.length).toBe(0);
  });
  it('prevents duplicate pending payments and focuses authoritative field errors without losing input', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}}); let finish!: () => void;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/payments') && init?.method === 'POST') {await new Promise<void>(resolve => {finish = resolve;}); return new Response(JSON.stringify({error: {code: 'validation_failed', message: 'Payment rejected.', field_errors: [{path: '/method', code: 'invalid', message: 'Select the actual payment method.'}, {path: '/reference', code: 'invalid', message: 'Enter a bank reference.'}], details: {}}}), {status: 422});}
      return fixture.fetch(input, init);
    });
    const {user} = await start(order.id, transport); await review(user); await user.click(screen.getByRole('button', {name: 'Confirm payment'}));
    expect(screen.getByRole('button', {name: 'Saving...'})).toBeDisabled(); expect(screen.getByRole('button', {name: 'Close transaction'})).toBeDisabled(); await user.click(screen.getByRole('button', {name: 'Saving...'}));
    await act(async () => finish()); await screen.findByText('Enter a bank reference.'); await waitFor(() => expect(screen.getByLabelText('Payment method')).toHaveFocus()); expect(screen.getByLabelText('Payment method')).toHaveAccessibleDescription('Select the actual payment method.');
    expect(screen.getByLabelText('Payment reference')).toHaveValue('Retained receipt'); expect(screen.getByLabelText('Payment amount')).toHaveValue('180'); expect(sessionStorage.length).toBe(0);
    expect(transport.mock.calls.filter(([input]) => String(input).endsWith('/payments'))).toHaveLength(1);
  });
  it('blocks resubmission when a conflicting latest record cannot be verified', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const {user} = await start(order.id, async (input, init) => {
      if (String(input).endsWith('/payments')) return new Response(JSON.stringify({error: {code: 'version_conflict', message: 'Stale version.', field_errors: [], details: {latest_resource: {...order, id: 'another-order'}}}}), {status: 409});
      return fixture.fetch(input, init);
    });
    await review(user); await user.click(screen.getByRole('button', {name: 'Confirm payment'})); await screen.findByText(/The latest order could not be verified/);
    expect(screen.getByLabelText('Payment reference')).toHaveValue('Retained receipt'); expect(screen.getByRole('button', {name: 'Review payment'})).toBeDisabled();
  });
  it('uses backend refund caps for the selected original payment', async () => {
    const {api, fixture, order, payment} = await financialApi(); await payment(1, 5000); await payment(2, 4000); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const {user} = await start(order.id, fixture.fetch); await user.click(screen.getByRole('button', {name: 'Record refund'}));
    await user.type(screen.getByLabelText('Refund amount'), '50.01'); await user.type(screen.getByLabelText('Refund reason'), 'Return'); await user.click(screen.getByRole('button', {name: 'Review refund'}));
    expect(screen.getByText('Amount must not exceed $50.00.')).toBeVisible(); const selector = screen.getByLabelText('Original payment');
    await user.selectOptions(selector, (selector as HTMLSelectElement).options[1].value); await user.click(screen.getByRole('button', {name: 'Review refund'})); expect(screen.getByText('Amount must not exceed $40.00.')).toBeVisible();
  });
  it('obeys recorded-preparation permission and requires consumed-stock cancellation acknowledgment', async () => {
    const {api, fixture, order} = await financialApi(); await api.request(`/orders/${order.id}/transitions`, {method: 'POST', operationId: 'begin-preparing', body: {expected_version: 1, to_status: 'preparing'}}); await api.request('/auth/sign-out', {method: 'POST', body: {}});
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fixture.fetch(input, init);
      if (String(input).endsWith(`/orders/${order.id}`)) {const saved = await response.json(); saved.cancellation_requires_stock_acknowledgment = true; saved.permitted_actions.mark_ready = {allowed: false, reason_code: 'remaining_preparation', reason: 'Record all remaining preparation before marking ready.'}; return new Response(JSON.stringify(saved));} return response;
    });
    const {user} = await start(order.id, transport); expect(screen.getByRole('button', {name: 'Mark ready'})).toBeDisabled(); expect(screen.getByText(/Record all remaining preparation/)).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Cancel order'})); await user.type(screen.getByLabelText('Cancellation reason'), 'Customer request');
    await user.click(screen.getByRole('button', {name: 'Confirm cancellation'})); expect(screen.getByText(/Acknowledge the consumed stock/)).toBeVisible();
    expect(screen.getByRole('checkbox', {name: /Consumed ingredients will not be restored/})).toHaveAccessibleDescription('Acknowledge the consumed stock before cancelling.');
    expect(transport.mock.calls.filter(([input]) => String(input).endsWith('/cancel'))).toHaveLength(0);
    await user.click(screen.getByRole('checkbox', {name: /Consumed ingredients will not be restored/})); await user.click(screen.getByRole('button', {name: 'Confirm cancellation'})); await screen.findByText('Version 3');
    const call = transport.mock.calls.find(([input]) => String(input).endsWith('/cancel')); expect(JSON.parse(String(call![1]?.body)).acknowledge_consumed_stock).toBe(true);
  });
  it('keeps an unresolved marker when a late operation result arrives after session expiry', async () => {
    const {api, fixture, order} = await financialApi(); await api.request('/auth/sign-out', {method: 'POST', body: {}}); let finish!: () => void;
    const {user, client} = await start(order.id, async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (String(input).endsWith('/payments') && init?.method === 'POST') throw new TypeError('lost');
      if (String(input).includes('/operations/')) await new Promise<void>(resolve => {finish = resolve;});
      return response;
    });
    await review(user); await user.click(screen.getByRole('button', {name: 'Confirm payment'})); await user.click(await screen.findByRole('button', {name: 'Check transaction status'}));
    const marker = sessionStorage.getItem(orderOperationMarker); fixture.expire(); await act(async () => {await expect(client.request('/auth/session')).rejects.toMatchObject({status: 401});});
    await screen.findByRole('button', {name: 'Sign in'}); await act(async () => finish()); expect(sessionStorage.getItem(orderOperationMarker)).toBe(marker); expect(screen.queryByText('Retained receipt')).not.toBeInTheDocument();
  });
});
