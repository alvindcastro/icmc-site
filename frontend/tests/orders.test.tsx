import {act, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter, useLocation} from 'react-router-dom';
import {describe, expect, it, vi} from 'vitest';
import {App} from '../src/App';
import {createApiClient} from '../src/api/client';
import {createFixtureTransport} from '../src/api/fixtures';
import type {FetchTransport} from '../src/api/types';
import {seedOrder} from './order-helpers';
import {behindServer} from './helpers';
import {orderOperationMarker} from '../src/orders/OrderEditor';

function Location() {const route = useLocation(); return <output aria-label="Current route">{route.pathname + route.search}</output>;}
async function start(path = '/orders', transport: FetchTransport = createFixtureTransport({latency: 0}).fetch) {
  const client = createApiClient({baseUrl: '/api/v1', transport});
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[path]}><App client={client} mode="fixtures" /><Location /></MemoryRouter>);
  const login = await screen.findByRole('button', {name: 'Sign in'});
  await user.type(screen.getByLabelText('Token'), 'local-admin-token'); await user.click(login);
  return {user, client};
}
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Customer name'), 'New Customer');
  await user.type(screen.getByLabelText('Contact phone'), '555-0100');
  await user.type(screen.getByLabelText('Fulfillment date'), '2026-10-10');
  await user.type(screen.getByLabelText('Fulfillment time'), '12:00');
  const select = screen.getByLabelText('Food and variant');
  const medium = within(select).getByRole('option', {name: /Beef Caldereta.*Medium/}) as HTMLOptionElement;
  await user.selectOptions(select, medium.value); await user.click(screen.getByRole('button', {name: 'Add item'}));
  await user.clear(screen.getByLabelText('Quantity for item 1')); await user.type(screen.getByLabelText('Quantity for item 1'), '2');
  const shanghai = within(select).getByRole('option', {name: /Shanghai Spring Rolls/}) as HTMLOptionElement;
  await user.selectOptions(select, shanghai.value); await user.click(screen.getByRole('button', {name: 'Add item'}));
}
describe('reservation workflow', () => {
  it('protects Orders, shows empty state and delivered navigation, validates and creates the $215 reviewed order', async () => {
    const {user} = await start();
    expect(await screen.findByText('No orders yet.')).toBeVisible();
    expect(screen.getByRole('link', {name: 'Orders'})).toBeVisible();
    expect(screen.getByRole('link', {name: 'Dashboard'})).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'New order'}));
    await user.click(screen.getByRole('button', {name: 'Review order'}));
    expect(screen.getByLabelText('Customer name')).toHaveFocus();
    await fill(user);
    await user.click(screen.getByRole('button', {name: 'Review order'}));
    const review = await screen.findByRole('region', {name: 'Order review'});
    expect(within(review).getAllByText('$215.00').length).toBeGreaterThan(0);
    expect(within(review).getByText('$160.00')).toBeVisible();
    expect(within(review).getAllByText('1 package / 100 pieces')[0]).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Confirm order'}));
    expect(await screen.findByRole('heading', {name: 'DEV-0001'})).toBeVisible();
    expect(screen.getByText('New Customer')).toBeVisible();
    expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0);
    expect(screen.getByText('Unpaid')).toBeVisible();
    expect(sessionStorage.length).toBe(0);
  });

  it('requires delivery address only for delivery, removes rows and protects unsaved changes', async () => {
    const {user} = await start(); await user.click(await screen.findByRole('button', {name: 'New order'}));
    await fill(user); await user.click(screen.getByLabelText('Delivery'));
    await user.click(screen.getByRole('button', {name: 'Review order'}));
    expect(screen.getByLabelText('Delivery address')).toHaveFocus();
    expect(screen.getByText('Enter a delivery address.')).toBeVisible();
    await user.click(screen.getByLabelText('Pickup'));
    expect(screen.queryByLabelText('Delivery address')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Remove item 2'}));
    expect(screen.queryByLabelText('Quantity for item 2')).not.toBeInTheDocument();
    await user.keyboard('{Escape}'); expect(screen.getByRole('heading', {name: 'Discard changes?'})).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Keep editing'})); expect(screen.getByLabelText('Customer name')).toHaveValue('New Customer');
    const unload = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
  });

  it('clears stale quote totals after changes and retains fields on quote failures', async () => {
    const fixture = createFixtureTransport({latency: 0}); let fail = false;
    const {user} = await start('/orders', async (input, init) => {
      if (fail && String(input).endsWith('/orders/quote')) return new Response(JSON.stringify({error: {code: 'validation_failed', message: 'Check quantity.',
        field_errors: [{path: '/draft/items/0/quantity', code: 'invalid', message: 'Quantity exceeds availability.'}], details: {}}}), {status: 422});
      return fixture.fetch(input, init);
    });
    await user.click(await screen.findByRole('button', {name: 'New order'})); await fill(user);
    await user.click(screen.getByRole('button', {name: 'Review order'})); await screen.findByRole('region', {name: 'Order review'});
    await user.click(screen.getByRole('button', {name: 'Back to edit'})); fail = true;
    await user.clear(screen.getByLabelText('Quantity for item 1')); await user.type(screen.getByLabelText('Quantity for item 1'), '3');
    expect(screen.queryByText('$215.00')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Review order'}));
    expect(await screen.findByText('Quantity exceeds availability.')).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText('Quantity for item 1')).toHaveFocus());
    expect(screen.getByLabelText('Customer name')).toHaveValue('New Customer');
  });

  it('saves pending and confirms it only after a separate review', async () => {
    const {user} = await start('/dashboard?date=2026-10-10'); await user.click(await screen.findByRole('button', {name: 'New order'})); await fill(user);
    await user.click(screen.getByRole('button', {name: 'Review order'}));
    await user.click(await screen.findByRole('button', {name: 'Save pending'}));
    expect(await screen.findByRole('heading', {name: 'DEV-0001'})).toBeVisible();
    expect(screen.getByRole('link', {name: 'Back to dashboard'})).toHaveAttribute('href', '/dashboard?date=2026-10-10');
    await user.click(screen.getByRole('button', {name: 'Review confirmation'}));
    expect(await screen.findByRole('region', {name: 'Order review'})).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Confirm order'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0);
  });

  it('edits saved snapshots despite menu changes and preserves draft through a two-staff conflict', async () => {
    const fixture = createFixtureTransport({latency: 0}); const order = await seedOrder(fixture.fetch);
    const {user, client} = await start(`/orders/${order.id}`, fixture.fetch);
    await user.click(await screen.findByRole('button', {name: 'Edit order'}));
    expect(screen.getByLabelText('Customer name')).toHaveValue('Sample Customer');
    await user.clear(screen.getByLabelText('Customer name')); await user.type(screen.getByLabelText('Customer name'), 'My unsaved name');
    const {fulfillment_at: _at, pickup_location: _pickup, ...fulfillment} = order.fulfillment;
    const draft = {customer: {...order.customer, name: 'Other staff name'}, fulfillment,
      items: order.items.map(item => ({client_line_id: item.id, order_item_id: item.id, variant_id: item.variant_id, quantity: item.quantity, preparation_notes: item.preparation_notes})),
      notes: order.notes, delivery_charge_minor: 0, tax_minor: 0};
    const quote = await client.request<{id: string}>('/orders/quote', {method: 'POST', body: {order_id: order.id, expected_version: 1, draft}});
    await client.request(`/orders/${order.id}`, {method: 'PUT', operationId: 'other-staff', body: {expected_version: 1, quote_id: quote.id, draft, acknowledge_credit: false}});
    await user.click(screen.getByRole('button', {name: 'Review order'}));
    expect(await screen.findByText('Latest saved order')).toBeVisible(); expect(screen.getByText('Other staff name')).toBeVisible();
    expect(screen.getByLabelText('Customer name')).toHaveValue('My unsaved name');
    await user.click(screen.getByRole('button', {name: 'Keep draft with reviewed version'}));
    await user.click(screen.getByRole('button', {name: 'Review order'}));
    await user.click(await screen.findByRole('button', {name: 'Save changes'}));
    expect(await screen.findByText('My unsaved name')).toBeVisible();
  });

  it('reconciles an uncertain committed order instead of creating a duplicate', async () => {
    const fixture = createFixtureTransport({latency: 0});
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fixture.fetch(input, init);
      if (String(input).endsWith('/orders') && init?.method === 'POST') throw new TypeError('lost response');
      return response;
    });
    const {user} = await start('/orders', transport); await user.click(await screen.findByRole('button', {name: 'New order'})); await fill(user);
    await user.click(screen.getByRole('button', {name: 'Review order'})); await user.click(await screen.findByRole('button', {name: 'Confirm order'}));
    expect(await screen.findByRole('button', {name: 'Check save status'})).toBeVisible();
    expect(screen.getByRole('button', {name: 'Confirm order'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check save status'}));
    expect(await screen.findByRole('heading', {name: 'DEV-0001'})).toBeVisible();
    expect(transport.mock.calls.filter(([input, init]) => String(input).endsWith('/orders') && init?.method === 'POST')).toHaveLength(1);
  });

  it('filters list state, returns from details, and groups dashboard by the selected business date', async () => {
    const fixture = createFixtureTransport({latency: 0}); const order = await seedOrder(fixture.fetch);
    const {user} = await start('/orders?q=Sample&status=confirmed&sort=fulfillment_desc', fixture.fetch);
    const link = await screen.findByRole('link', {name: order.reference}); await user.click(link);
    expect(await screen.findByRole('heading', {name: order.reference})).toBeVisible();
    await user.click(screen.getByRole('link', {name: 'Back to orders'}));
    expect(await screen.findByLabelText('Search orders')).toHaveValue('Sample');
    expect(screen.getByLabelText('Order status filter')).toHaveValue('confirmed');
    await user.click(screen.getByRole('button', {name: 'Clear order filters'}));
    await user.type(screen.getByLabelText('Search orders'), 'missing');
    expect(await screen.findByText('No orders match these filters.')).toBeVisible();
    await user.click(screen.getByRole('link', {name: 'Dashboard'}));
    await user.clear(await screen.findByLabelText('Dashboard date')); await user.type(screen.getByLabelText('Dashboard date'), '2026-10-10');
    expect(await screen.findByRole('link', {name: order.reference})).toBeVisible();
    expect(screen.getByRole('heading', {name: "Today's orders"})).toBeVisible();
  });

  it('discards a late quote and focuses validation after an in-flight draft becomes invalid', async () => {
    const fixture = createFixtureTransport({latency: 0}); let hold = false; let finish!: () => void;
    const {user} = await start('/orders', async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (hold && String(input).endsWith('/orders/quote')) await new Promise<void>(resolve => {finish = resolve;});
      return response;
    });
    await user.click(await screen.findByRole('button', {name: 'New order'})); await fill(user); hold = true;
    await user.click(screen.getByRole('button', {name: 'Review order'}));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await user.clear(screen.getByLabelText('Customer name')); await user.click(screen.getByRole('button', {name: 'Review order'}));
    await act(async () => {hold = false; finish();});
    expect(screen.queryByRole('region', {name: 'Order review'})).not.toBeInTheDocument();
    expect(screen.queryByText('$215.00')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Customer name')).toHaveFocus());
    expect(screen.getByText('Totals awaiting quote.')).toBeVisible();
  });

  it('offers only an explicit identical-key retry after an uncertain unrecorded save', async () => {
    const fixture = createFixtureTransport({latency: 0}); let lose = true;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (lose && String(input).endsWith('/orders') && init?.method === 'POST') {lose = false; throw new TypeError('request lost');}
      return fixture.fetch(input, init);
    });
    const {user} = await start('/orders', transport); await user.click(await screen.findByRole('button', {name: 'New order'})); await fill(user);
    await user.click(screen.getByRole('button', {name: 'Review order'})); await user.click(await screen.findByRole('button', {name: 'Confirm order'}));
    await user.click(await screen.findByRole('button', {name: 'Check save status'}));
    await user.click(await screen.findByRole('button', {name: 'Retry identical save'}));
    await screen.findByRole('heading', {name: 'DEV-0001'});
    const saves = transport.mock.calls.filter(([input, init]) => String(input).endsWith('/orders') && init?.method === 'POST');
    expect(saves).toHaveLength(2); expect(saves[0][1]?.body).toBe(saves[1][1]?.body);
    expect(new Headers(saves[0][1]?.headers).get('Idempotency-Key')).toBe(new Headers(saves[1][1]?.headers).get('Idempotency-Key'));
  });

  it('retains only the operation marker on expiry and reconciles read-only after sign-in', async () => {
    const fixture = createFixtureTransport({latency: 0});
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fixture.fetch(input, init);
      if (String(input).endsWith('/orders') && init?.method === 'POST') {fixture.expire(); throw new TypeError('lost committed response');}
      return response;
    });
    const {user, client} = await start('/orders', transport); await user.click(await screen.findByRole('button', {name: 'New order'})); await fill(user);
    await user.click(screen.getByRole('button', {name: 'Review order'})); await user.click(await screen.findByRole('button', {name: 'Confirm order'}));
    await screen.findByRole('button', {name: 'Check save status'});
    await act(async () => {await expect(client.request('/auth/session')).rejects.toMatchObject({status: 401});});
    await screen.findByRole('button', {name: 'Sign in'}); expect(screen.queryByText('New Customer')).not.toBeInTheDocument();
    expect(sessionStorage.length).toBe(1); expect(sessionStorage.getItem(orderOperationMarker)).toBeTruthy(); expect(localStorage.length).toBe(0);
    await user.type(screen.getByLabelText('Token'), 'local-admin-token'); await user.click(screen.getByRole('button', {name: 'Sign in'}));
    expect(await screen.findByRole('button', {name: 'New order'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check save status'})); await screen.findByRole('heading', {name: 'DEV-0001'});
    expect(transport.mock.calls.filter(([input, init]) => String(input).endsWith('/orders') && init?.method === 'POST')).toHaveLength(1);
  });

  it('blocks a new order when the unresolved UUID survives without its draft', async () => {
    sessionStorage.setItem(orderOperationMarker, 'lost-draft');
    const {user} = await start(); expect(await screen.findByRole('button', {name: 'New order'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check save status'}));
    expect(await screen.findByText(/original draft is no longer available/)).toBeVisible();
    expect(screen.getByRole('button', {name: 'New order'})).toBeDisabled();
  });

  it('fails closed for disabled orders and unconfirmed live business settings', async () => {
    const fixture = createFixtureTransport({latency: 0}); let live = false;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fixture.fetch(input, init);
      if (String(input).endsWith('/settings')) {const settings = await response.json(); return new Response(JSON.stringify({...settings, environment: live ? 'live' : 'development', capabilities: {...settings.capabilities, orders: live}}));}
      return response;
    });
    const {user, client} = await start('/orders', transport);
    expect(await screen.findByRole('heading', {name: 'Orders unavailable'})).toBeVisible();
    expect(transport.mock.calls.some(([input]) => String(input).includes('/orders?'))).toBe(false);
    await user.click(screen.getByRole('button', {name: 'Sign out'})); await screen.findByRole('button', {name: 'Sign in'}); live = true;
    await user.type(screen.getByLabelText('Token'), 'local-admin-token'); await user.click(screen.getByRole('button', {name: 'Sign in'}));
    expect(await screen.findByText('Business settings require confirmation before live reservations.')).toBeVisible();
    expect(screen.queryByRole('button', {name: 'New order'})).not.toBeInTheDocument();
    expect(client).toBeTruthy();
  });

  it('rejects malformed list responses and recovers without inventing totals', async () => {
    const fixture = createFixtureTransport({latency: 0}); await seedOrder(fixture.fetch); let bad = true;
    const {user} = await start('/orders', async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (bad && String(input).includes('/orders?')) {const page = await response.json(); page.items[0].total_minor = '21500'; return new Response(JSON.stringify(page));}
      return response;
    });
    expect(await screen.findByText('The server returned an invalid order response.')).toBeVisible(); expect(screen.queryByText('$215.00')).not.toBeInTheDocument();
    bad = false; await user.click(screen.getByRole('button', {name: 'Retry'})); expect(await screen.findByRole('link', {name: 'DEV-0001'})).toBeVisible();
  });

  it('requires a daylight-saving occurrence and displays the chosen business instant', async () => {
    const {user} = await start(); await user.click(await screen.findByRole('button', {name: 'New order'})); await fill(user);
    await user.clear(screen.getByLabelText('Fulfillment date')); await user.type(screen.getByLabelText('Fulfillment date'), '2026-11-01');
    await user.clear(screen.getByLabelText('Fulfillment time')); await user.type(screen.getByLabelText('Fulfillment time'), '01:30');
    await user.click(screen.getByRole('button', {name: 'Review order'}));
    const offset = await screen.findByLabelText('Time occurrence (UTC offset)'); await waitFor(() => expect(offset).toHaveFocus());
    await user.selectOptions(offset, '-08:00'); await user.click(screen.getByRole('button', {name: 'Review order'}));
    expect(await screen.findByText(/Nov 1, 2026, 1:30 AM \(-08:00\)/)).toBeVisible();
  });

  it('drops an expired review and requires another review before saving', async () => {
    const fixture = createFixtureTransport({latency: 0}); let short = false;
    const {user} = await start('/orders', async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (short && String(input).endsWith('/orders/quote')) {const quote = await response.json(); quote.expires_at = new Date(Date.now() + 250).toISOString(); return new Response(JSON.stringify(quote));}
      return response;
    });
    await user.click(await screen.findByRole('button', {name: 'New order'})); await fill(user); short = true;
    await user.click(screen.getByRole('button', {name: 'Review order'})); await screen.findByRole('region', {name: 'Order review'});
    expect(await screen.findByText('Quote expired. Review the order again.')).toBeVisible();
    expect(screen.queryByRole('button', {name: 'Confirm order'})).not.toBeInTheDocument(); expect(screen.getByLabelText('Customer name')).toHaveValue('New Customer');
  });

  it('never treats a quote for another fulfillment date as the current review', async () => {
    const fixture = createFixtureTransport({latency: 0});
    const {user} = await start('/orders', async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (String(input).endsWith('/orders/quote') && response.ok) {const quote = await response.json(); quote.fulfillment.local_date = '2026-10-11'; quote.fulfillment.fulfillment_at = '2026-10-11T19:00:00Z'; return new Response(JSON.stringify(quote));}
      return response;
    });
    await user.click(await screen.findByRole('button', {name: 'New order'})); await fill(user); await user.click(screen.getByRole('button', {name: 'Review order'}));
    expect(await screen.findByText('The quote could not be matched to this draft.')).toBeVisible();
    expect(screen.queryByRole('region', {name: 'Order review'})).not.toBeInTheDocument(); expect(screen.getByLabelText('Customer name')).toHaveValue('New Customer');
  });

  it('does not clear an unresolved marker from a late reconciliation response after sign-out', async () => {
    const fixture = createFixtureTransport({latency: 0}); let finish!: () => void;
    const {user} = await start('/orders', async (input, init) => {
      if (String(input).endsWith('/operations/earlier-op')) {
        await new Promise<void>(resolve => {finish = resolve;});
        return new Response(JSON.stringify({operation_id: 'earlier-op', state: 'rejected', resource_type: null, resource_id: null, result: null,
          error: {http_status: 422, error: {code: 'invalid', message: 'No effect.', field_errors: [], details: {}}}, started_at: new Date().toISOString(), completed_at: new Date().toISOString()}));
      }
      return fixture.fetch(input, init);
    });
    // Remounting the area reads only this marker, never a persisted draft.
    sessionStorage.setItem(orderOperationMarker, 'earlier-op');
    await user.click(await screen.findByRole('link', {name: 'Menu & Recipes'})); await screen.findByRole('heading', {name: 'Menu'});
    await user.click(screen.getByRole('link', {name: 'Orders'})); await user.click(await screen.findByRole('button', {name: 'Check save status'}));
    await user.click(screen.getByRole('button', {name: 'Sign out'})); await screen.findByRole('button', {name: 'Sign in'});
    await act(async () => finish());
    expect(sessionStorage.getItem(orderOperationMarker)).toBe('earlier-op'); expect(screen.queryByText('No effect.')).not.toBeInTheDocument();
  });

  it('disables repeat submissions while saving and retains draft on authoritative save field errors', async () => {
    const fixture = createFixtureTransport({latency: 0}); let finish!: () => void;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/orders') && init?.method === 'POST') {await new Promise<void>(resolve => {finish = resolve;}); return new Response(JSON.stringify({error: {code: 'validation_failed', message: 'Check customer.', field_errors: [{path: '/draft/customer/phone', code: 'invalid', message: 'Enter a reachable phone.'}], details: {}}}), {status: 422});}
      return fixture.fetch(input, init);
    });
    const {user} = await start('/orders', transport); await user.click(await screen.findByRole('button', {name: 'New order'})); await fill(user);
    await user.click(screen.getByRole('button', {name: 'Review order'})); await user.click(await screen.findByRole('button', {name: 'Confirm order'}));
    expect(screen.getByRole('button', {name: 'Saving...'})).toBeDisabled(); await user.click(screen.getByRole('button', {name: 'Saving...'}));
    await act(async () => finish()); expect(await screen.findByText('Enter a reachable phone.')).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText('Contact phone')).toHaveFocus()); expect(screen.getByLabelText('Customer name')).toHaveValue('New Customer');
    expect(transport.mock.calls.filter(([input, init]) => String(input).endsWith('/orders') && init?.method === 'POST')).toHaveLength(1);
    expect(sessionStorage.length).toBe(0);
  });

  it('requires explicit acknowledgment of backend customer credit before an edited save', async () => {
    const fixture = createFixtureTransport({latency: 0}); const order = await seedOrder(fixture.fetch);
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fixture.fetch(input, init);
      if (String(input).endsWith('/orders/quote') && response.ok) {const quote = await response.json(); return new Response(JSON.stringify({...quote, net_paid_minor: 30000, balance_due_minor: 0, customer_credit_minor: 8500, credit_acknowledgment_required: true}));}
      return response;
    });
    const {user} = await start(`/orders/${order.id}`, transport); await user.click(await screen.findByRole('button', {name: 'Edit order'}));
    await user.click(screen.getByRole('button', {name: 'Review order'})); const save = await screen.findByRole('button', {name: 'Save changes'}); expect(save).toBeDisabled();
    await user.click(screen.getByRole('checkbox', {name: /Acknowledge customer credit of \$85.00/})); expect(save).toBeEnabled(); await user.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const update = transport.mock.calls.find(([input, init]) => String(input).endsWith(`/orders/${order.id}`) && init?.method === 'PUT'); expect(JSON.parse(String(update![1]?.body)).acknowledge_credit).toBe(true);
  });

  it('keeps a stale-price save out of details until staff obtains and reviews a new quote', async () => {
    const fixture = createFixtureTransport({latency: 0}); const {user, client} = await start('/orders', fixture.fetch);
    await user.click(await screen.findByRole('button', {name: 'New order'})); await fill(user); await user.click(screen.getByRole('button', {name: 'Review order'}));
    await screen.findByRole('region', {name: 'Order review'});
    const menu = await client.request<{items: import('../src/api/types').Food[]}>('/foods?limit=100'); const variant = menu.items.find(food => food.name === 'Beef Caldereta')!.variants.find(variant => variant.label === 'Medium')!;
    await client.request(`/variants/${variant.id}`, {method: 'PATCH', operationId: 'change-during-review', body: {expected_version: variant.version, price_minor: 9000}});
    await user.click(screen.getByRole('button', {name: 'Confirm order'})); expect(await screen.findByText(/Menu or business settings changed/)).toBeVisible();
    expect(screen.queryByRole('heading', {name: 'DEV-0001'})).not.toBeInTheDocument(); expect(screen.queryByText('$215.00')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Review order'})); const review = await screen.findByRole('region', {name: 'Order review'}); expect(within(review).getAllByText('$235.00').length).toBeGreaterThan(0);
  });

  it('links additional dashboard rows to the corresponding business-day collection', async () => {
    const fixture = createFixtureTransport({latency: 0}); const order = await seedOrder(fixture.fetch);
    const {user} = await start('/dashboard?date=2026-10-10', async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (String(input).includes('/dashboard?')) {const dashboard = await response.json(); dashboard.today = {...dashboard.today, has_next: true, total: 26};
        dashboard.upcoming = {...dashboard.today, items: dashboard.today.items.map((row: Record<string, unknown>) => ({...row, fulfillment_local_date: '2026-10-11', fulfillment_at: '2026-10-11T19:00:00Z'}))}; return new Response(JSON.stringify(dashboard));}
      return response;
    });
    const today = await screen.findByRole('link', {name: 'View all orders for this date'}); const upcoming = screen.getByRole('link', {name: 'View all upcoming orders'});
    const todayQuery = new URL(today.getAttribute('href')!, 'http://local').searchParams;
    const upcomingQuery = new URL(upcoming.getAttribute('href')!, 'http://local').searchParams;
    expect(todayQuery.get('date_from')).toBe('2026-10-10'); expect(todayQuery.get('date_to')).toBe('2026-10-10');
    expect(todayQuery.get('status')).not.toContain('cancelled'); expect(upcomingQuery.get('date_from')).toBe('2026-10-11'); expect(upcomingQuery.get('status')).not.toContain('completed');
    await user.click(upcoming); expect(await screen.findByLabelText('From date')).toHaveValue('2026-10-11');
    expect(screen.getByLabelText('Order status filter')).toHaveValue('pending,confirmed,preparing,ready'); expect(order).toBeTruthy();
  });

  it('keeps the filtered list return route after a successful detail edit', async () => {
    const fixture = createFixtureTransport({latency: 0}); await seedOrder(fixture.fetch);
    const {user} = await start('/orders?q=Sample&status=confirmed', fixture.fetch);
    await user.click(await screen.findByRole('link', {name: 'DEV-0001'})); await user.click(await screen.findByRole('button', {name: 'Edit order'}));
    await user.type(screen.getByLabelText('Order notes'), ' Updated'); await user.click(screen.getByRole('button', {name: 'Review order'}));
    await user.click(await screen.findByRole('button', {name: 'Save changes'})); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await screen.findByText('Version 2');
    expect(screen.getByRole('link', {name: 'Back to orders'})).toHaveAttribute('href', '/orders?q=Sample&status=confirmed');
  });

  it('confirms before closing an unresolved order save and retries the identical request from the page', async () => {
    const fixture = createFixtureTransport({latency: 0}); let offline = true;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (offline && String(input).endsWith('/orders') && init?.method === 'POST') throw new TypeError('offline before submission');
      return fixture.fetch(input, init);
    });
    const {user} = await start('/orders', transport); await user.click(await screen.findByRole('button', {name: 'New order'})); await fill(user);
    await user.click(screen.getByRole('button', {name: 'Review order'})); await user.click(await screen.findByRole('button', {name: 'Confirm order'}));
    await screen.findByRole('button', {name: 'Check save status'}); await user.keyboard('{Escape}');
    expect(screen.getByText(/still unresolved/)).toBeVisible(); await user.click(screen.getByRole('button', {name: 'Discard changes'}));
    expect(screen.getByRole('button', {name: 'New order'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check save status'}));
    offline = false; await user.click(await screen.findByRole('button', {name: 'Retry identical save'}));
    expect(await screen.findByRole('heading', {name: 'DEV-0001'})).toBeVisible();
    const posts = transport.mock.calls.filter(([input, init]) => String(input).endsWith('/orders') && init?.method === 'POST');
    expect(posts).toHaveLength(2); expect(posts[1][1]?.body).toBe(posts[0][1]?.body);
    expect(new Headers(posts[1][1]?.headers).get('Idempotency-Key')).toBe(new Headers(posts[0][1]?.headers).get('Idempotency-Key'));
    expect(sessionStorage.length).toBe(0);
  });

  it('opens a saved delivery order after delivery is disabled and offers the remaining method', async () => {
    const fixture = createFixtureTransport({latency: 0});
    const order = await seedOrder(fixture.fetch, {fulfillment: {method: 'delivery', local_date: '2026-10-10', local_time: '12:00', timezone: 'America/Los_Angeles', utc_offset: null, address: '1 Main St'}, delivery_charge_minor: 500});
    const {user} = await start(`/orders/${order.id}`, async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (String(input).endsWith('/settings')) {const settings = await response.json(); settings.delivery_policy = {mode: 'disabled', fixed_charge_minor: null}; return new Response(JSON.stringify(settings));}
      return response;
    });
    await user.click(await screen.findByRole('button', {name: 'Edit order'}));
    expect(screen.getByRole('heading', {name: 'Edit order'})).toBeVisible();
    expect(screen.getByText('Delivery is no longer enabled. Choose another fulfillment method.')).toBeVisible();
    expect(screen.queryByLabelText('Delivery charge')).not.toBeInTheDocument(); expect(screen.queryByRole('radio', {name: 'Delivery'})).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', {name: 'Pickup'}));
    expect(screen.queryByText(/Delivery is no longer enabled/)).not.toBeInTheDocument();
  });

  it('accepts and saves a current quote when the device clock runs ahead of the server', async () => {
    const {user} = await start('/orders', behindServer(createFixtureTransport({latency: 0}).fetch, 6 * 60000));
    await user.click(await screen.findByRole('button', {name: 'New order'})); await fill(user);
    await user.click(screen.getByRole('button', {name: 'Review order'})); await user.click(await screen.findByRole('button', {name: 'Confirm order'}));
    expect(await screen.findByRole('heading', {name: 'DEV-0001'})).toBeVisible();
  });
});
