import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { createApiClient } from '../src/api/client';
import { createFixtureTransport } from '../src/api/fixtures';
import type { FetchTransport, Food } from '../src/api/types';

function Location() { return <output aria-label="Current route">{useLocation().search}</output>; }
async function start(transport: FetchTransport = createFixtureTransport({latency: 0}).fetch, path = '/menu') {
  const client = createApiClient({baseUrl: '/api/v1', transport});
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[path]}><App client={client} mode="fixtures" /><Location /></MemoryRouter>);
  if (await screen.findByLabelText('Username')) {
    await user.type(screen.getByLabelText('Token'), 'local-admin-token');
    await user.click(screen.getByRole('button', {name: 'Sign in'}));
  }
  await screen.findByRole('heading', {name: 'Menu'});
  return {client, user};
}
async function fillFood(user: ReturnType<typeof userEvent.setup>, name = 'New dish') {
  await user.type(screen.getByLabelText('Food name'), name);
  await user.selectOptions(screen.getByLabelText('Food category'), 'beef');
  await user.type(screen.getByLabelText('Description'), 'A retained description');
}
const failure = (status: number, code: string, fields: unknown[] = []) => new Response(JSON.stringify({error: {
  code, message: 'Check your changes.', field_errors: fields, details: {}, request_id: 'menu-test',
}}), {status});

describe('menu staff workflow', () => {
  it('returns to protected menu, displays provisional quantities/prices, searches and filters unavailable foods', async () => {
    const {user} = await start();
    expect(await screen.findByRole('heading', {name: 'Beef Caldereta'})).toBeVisible();
    expect(screen.getByRole('link', {name: 'Menu & Recipes'})).toBeVisible();
    expect(screen.getByText('1 package / 100 pieces')).toBeVisible();
    expect(screen.getByText('$80.00')).toBeVisible();
    expect(screen.getByText('Provisional development menu')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Availability filter'), 'false');
    expect(await screen.findByRole('heading', {name: 'Development skewers'})).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('heading', {name: 'Beef Caldereta'})).not.toBeInTheDocument());
    expect(screen.getByRole('button', {name: 'Edit food Development skewers'})).toBeEnabled();
    await user.click(screen.getByRole('button', {name: 'Clear filters'}));
    await user.type(screen.getByLabelText('Search menu'), 'nothere');
    expect(await screen.findByText('No foods match these filters.')).toBeVisible();
    expect(screen.getByLabelText('Current route')).toHaveTextContent('q=nothere');
    await user.click(screen.getByRole('button', {name: 'Clear filters'}));
    await user.selectOptions(screen.getByLabelText('Category filter'), 'beef');
    expect(await screen.findByRole('heading', {name: 'Beef Caldereta'})).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('heading', {name: 'Fresh Lumpia'})).not.toBeInTheDocument());
  });

  it('validates food, preserves dirty values on close, creates food and edits its name/category/description/availability', async () => {
    const {user} = await start();
    await user.click(await screen.findByRole('button', {name: 'Add food'}));
    await user.click(screen.getByRole('button', {name: 'Save food'}));
    expect(screen.getByLabelText('Food name')).toHaveFocus();
    expect(screen.getByText('Enter a food name.')).toBeVisible();
    await fillFood(user);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('heading', {name: 'Discard changes?'})).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Keep editing'}));
    expect(screen.getByLabelText('Food name')).toHaveValue('New dish');
    await user.click(screen.getByRole('button', {name: 'Save food'}));
    expect(await screen.findByText('Food saved.')).toBeVisible();
    await user.click(await screen.findByRole('button', {name: 'Edit food New dish'}));
    await user.clear(screen.getByLabelText('Food name'));
    await user.type(screen.getByLabelText('Food name'), 'Renamed dish');
    await user.selectOptions(screen.getByLabelText('Food category'), 'chicken');
    await user.click(screen.getByLabelText('Food available'));
    await user.click(screen.getByRole('button', {name: 'Save food'}));
    const food = await screen.findByRole('region', {name: 'Renamed dish'});
    expect(within(food).getByText('Chicken')).toBeVisible();
    expect(within(food).getByText('Unavailable')).toBeVisible();
    expect(within(food).getByText('A retained description')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Edit food Renamed dish'}));
    await user.type(screen.getByLabelText('Description'), ' edited');
    await user.click(screen.getByRole('button', {name: 'Close editor'}));
    await user.click(screen.getByRole('button', {name: 'Discard changes'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('adds multiple variants with exact prices/package contents and edits unavailable variants', async () => {
    const {user} = await start();
    await user.click(await screen.findByRole('button', {name: 'Add variant to Beef Caldereta'}));
    await user.click(screen.getByRole('button', {name: 'Save variant'}));
    expect(screen.getByLabelText('Variant label')).toHaveFocus();
    await user.type(screen.getByLabelText('Variant label'), 'Party box');
    await user.selectOptions(screen.getByLabelText('Selling unit'), 'package');
    await user.type(screen.getByLabelText('Price (USD)'), '80.001');
    await user.type(screen.getByLabelText('Pieces per package'), '0');
    await user.click(screen.getByRole('button', {name: 'Save variant'}));
    expect(screen.getByLabelText('Price (USD)')).toHaveFocus();
    expect(screen.getByText('Enter a nonnegative price with up to 2 decimal places.')).toBeVisible();
    await user.clear(screen.getByLabelText('Price (USD)')); await user.type(screen.getByLabelText('Price (USD)'), '80.01');
    await user.clear(screen.getByLabelText('Pieces per package')); await user.type(screen.getByLabelText('Pieces per package'), '100');
    await user.click(screen.getByLabelText('Variant available'));
    await user.click(screen.getByRole('button', {name: 'Save variant'}));
    expect(await screen.findByText('Variant saved.')).toBeVisible();
    expect(await screen.findByText('$80.01')).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Edit variant Party box of Beef Caldereta'}));
    expect(screen.getByLabelText('Variant available')).not.toBeChecked();
    await user.clear(screen.getByLabelText('Price (USD)')); await user.type(screen.getByLabelText('Price (USD)'), '0');
    await user.selectOptions(screen.getByLabelText('Selling unit'), 'stick');
    expect(screen.queryByLabelText('Pieces per package')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Save variant'}));
    expect(await screen.findByText('$0.00')).toBeVisible();
  });

  it('retains input and focuses server field errors; blocks duplicate submissions while saving', async () => {
    const fixture = createFixtureTransport({latency: 0});
    let release!: (response: Response) => void;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/foods') && init?.method === 'POST') return new Promise<Response>(resolve => {release = resolve;});
      return fixture.fetch(input, init);
    });
    const {user} = await start(transport);
    await user.click(await screen.findByRole('button', {name: 'Add food'}));
    await fillFood(user);
    await user.click(screen.getByRole('button', {name: 'Save food'}));
    expect(screen.getByRole('button', {name: 'Saving...'})).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST' && String(init.body).includes('New dish'))).toHaveLength(1);
    await act(async () => release(failure(422, 'validation_failed', [{path: '/name', code: 'duplicate', message: 'That name already exists.'}])));
    expect(await screen.findByText('That name already exists.')).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText('Food name')).toHaveFocus());
    expect(screen.getByLabelText('Description')).toHaveValue('A retained description');
  });

  it('preserves draft on version conflict and requires explicit latest-version review before saving', async () => {
    const {user, client} = await start();
    await user.click(await screen.findByRole('button', {name: 'Edit food Beef Caldereta'}));
    await user.clear(screen.getByLabelText('Food name')); await user.type(screen.getByLabelText('Food name'), 'My draft name');
    await client.request('/foods/fixture_caldereta', {method: 'PATCH', operationId: 'other-staff', body: {expected_version: 1, name: 'Other staff name'}});
    await user.click(screen.getByRole('button', {name: 'Save food'}));
    expect(await screen.findByText('Latest saved record')).toBeVisible();
    expect(screen.getByText('Other staff name')).toBeVisible();
    expect(screen.getByLabelText('Food name')).toHaveValue('My draft name');
    expect(screen.getByRole('button', {name: 'Save food'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Keep draft with reviewed version'}));
    expect(screen.getByLabelText('Food name')).toHaveValue('My draft name');
    await user.click(screen.getByRole('button', {name: 'Save food'}));
    expect(await screen.findByRole('heading', {name: 'My draft name'})).toBeVisible();
  });

  it('checks an uncertain committed save instead of creating a duplicate', async () => {
    const fixture = createFixtureTransport({latency: 0});
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fixture.fetch(input, init);
      if (String(input).endsWith('/foods') && init?.method === 'POST') throw new TypeError('lost response');
      return response;
    });
    const {user} = await start(transport);
    await user.click(await screen.findByRole('button', {name: 'Add food'}));
    await fillFood(user);
    await user.click(screen.getByRole('button', {name: 'Save food'}));
    expect(await screen.findByText('Save result unconfirmed. Check its status before another submission.')).toBeVisible();
    expect(screen.getByRole('button', {name: 'Save food'})).toBeDisabled();
    expect(screen.getByLabelText('Food name')).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check save status'}));
    expect(await screen.findByText('Food saved.')).toBeVisible();
    expect(await screen.findByRole('heading', {name: 'New dish'})).toBeVisible();
    expect(transport.mock.calls.filter(([input, init]) => String(input).endsWith('/foods') && init?.method === 'POST')).toHaveLength(1);
    expect(sessionStorage.length).toBe(0);
  });

  it('shows recoverable loading/error/empty states', async () => {
    const fixture = createFixtureTransport({latency: 0});
    let failed = true;
    const {user} = await start(async (input, init) => {
      if (String(input).includes('/foods?')) return failed ? failure(503, 'temporarily_unavailable') : new Response(JSON.stringify({items: [], page: 1, limit: 25, total: 0, has_next: false}));
      return fixture.fetch(input, init);
    });
    expect(await screen.findByRole('button', {name: 'Retry menu'})).toBeVisible();
    failed = false; await user.click(screen.getByRole('button', {name: 'Retry menu'}));
    expect(await screen.findByText('No foods yet.')).toBeVisible();
  });

  it('hides menu navigation and makes no menu requests when the capability is disabled', async () => {
    const fixture = createFixtureTransport({latency: 0});
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fixture.fetch(input, init);
      if (String(input).endsWith('/settings')) {
        const settings = await response.json(); settings.capabilities.menu = false;
        return new Response(JSON.stringify(settings));
      }
      return response;
    });
    await start(transport);
    expect(await screen.findByText('Menu management is not enabled.')).toBeVisible();
    expect(screen.queryByRole('link', {name: /^Menu/})).not.toBeInTheDocument();
    expect(transport.mock.calls.some(([input]) => /\/(foods|categories)/.test(String(input)))).toBe(false);
  });

  it('keeps the exact operation key and body for an explicit retry after a 404 lookup', async () => {
    const fixture = createFixtureTransport({latency: 0});
    let offline = true;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (offline && String(input).endsWith('/foods') && init?.method === 'POST') throw new TypeError('offline');
      return fixture.fetch(input, init);
    });
    const {user} = await start(transport);
    await user.click(await screen.findByRole('button', {name: 'Add food'})); await fillFood(user);
    await user.click(screen.getByRole('button', {name: 'Save food'}));
    await user.click(await screen.findByRole('button', {name: 'Check save status'}));
    expect(await screen.findByRole('button', {name: 'Retry original save'})).toBeVisible();
    offline = false; await user.click(screen.getByRole('button', {name: 'Retry original save'}));
    await screen.findByText('Food saved.');
    const calls = transport.mock.calls.filter(([input, init]) => String(input).endsWith('/foods') && init?.method === 'POST');
    expect(calls).toHaveLength(2);
    expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
    expect(new Headers(calls[0][1]?.headers).get('Idempotency-Key')).toBe(new Headers(calls[1][1]?.headers).get('Idempotency-Key'));
  });

  it('requires read-only reconciliation of a previous save before another mutation', async () => {
    sessionStorage.setItem('food-reservations:menu-operation', 'old-attempt');
    const fixture = createFixtureTransport({latency: 0});
    const transport = vi.fn(fixture.fetch);
    const {user} = await start(transport);
    expect(await screen.findByRole('button', {name: 'Check previous save'})).toBeVisible();
    expect(screen.getByRole('button', {name: 'Add food'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check previous save'}));
    expect(await screen.findByText(/ask the backend operator/)).toBeVisible();
    expect(sessionStorage.getItem('food-reservations:menu-operation')).toBe('old-attempt');
    expect(transport.mock.calls.some(([input, init]) => String(input).includes('/foods') && init?.method === 'POST')).toBe(false);
  });

  it('keeps menu draft private on expiry, returns to menu, and never replays a save', async () => {
    const fixture = createFixtureTransport({latency: 0});
    const transport = vi.fn(fixture.fetch);
    const {client, user} = await start(transport);
    await user.click(await screen.findByRole('button', {name: 'Add food'})); await fillFood(user, 'Private draft');
    const unload = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fixture.expire();
    await act(async () => {await expect(client.request('/foods')).rejects.toMatchObject({status: 401});});
    expect(await screen.findByText(/Your session expired/)).toBeVisible();
    expect(screen.queryByDisplayValue('Private draft')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Token'), 'local-admin-token');
    await user.click(screen.getByRole('button', {name: 'Sign in'}));
    expect(await screen.findByRole('heading', {name: 'Beef Caldereta'})).toBeVisible();
    expect(transport.mock.calls.some(([input, init]) => String(input).endsWith('/foods') && init?.method === 'POST')).toBe(false);
  });

  it('rejects malformed returned menu records as recoverable errors instead of displaying them', async () => {
    const fixture = createFixtureTransport({latency: 0});
    const {user} = await start(async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (String(input).includes('/foods?')) {
        const page = await response.json(); page.items[0].name = '';
        return new Response(JSON.stringify(page));
      }
      return response;
    });
    expect(await screen.findByRole('button', {name: 'Retry menu'})).toBeVisible();
    expect(screen.getByRole('button', {name: 'Add food'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Retry menu'}));
    expect(await screen.findByText('The server returned an invalid food record.')).toBeVisible();
  });

  it('does not claim a malformed save response succeeded; reconciles the actual returned record', async () => {
    const fixture = createFixtureTransport({latency: 0});
    const {user} = await start(async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (String(input).endsWith('/foods') && init?.method === 'POST') {
        const food = await response.json(); food.name = ''; return new Response(JSON.stringify(food), {status: 201});
      }
      return response;
    });
    await user.click(await screen.findByRole('button', {name: 'Add food'})); await fillFood(user);
    await user.click(screen.getByRole('button', {name: 'Save food'}));
    expect(await screen.findByRole('button', {name: 'Check save status'})).toBeVisible();
    expect(screen.queryByText('Food saved.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Check save status'}));
    expect(await screen.findByText('Food saved.')).toBeVisible();
  });

  it('honors resource permissions and exposes the backend reason on edit actions', async () => {
    const fixture = createFixtureTransport({latency: 0});
    await start(async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (String(input).includes('/foods?')) {
        const page = await response.json();
        page.items[0].permitted_actions.edit = {allowed: false, reason_code: 'locked', reason: 'This food is locked.'};
        page.items[0].permitted_actions.add_variant = {allowed: false, reason_code: 'locked', reason: 'Variants are locked.'};
        page.items[0].variants[0].permitted_actions.edit = {allowed: false, reason_code: 'locked', reason: 'This variant is locked.'};
        return new Response(JSON.stringify(page));
      }
      return response;
    });
    const edit = await screen.findByRole('button', {name: 'Edit food Beef Caldereta'});
    expect(edit).toBeDisabled(); expect(edit).toHaveAttribute('title', 'This food is locked.');
    expect(screen.getByRole('button', {name: 'Edit variant Small of Beef Caldereta'})).toHaveAttribute('title', 'This variant is locked.');
    expect(screen.getByRole('button', {name: 'Add variant to Beef Caldereta'})).toBeDisabled();
  });

  it('paginates menu/category responses, preserves URL state and resets page when filters change', async () => {
    const fixture = createFixtureTransport({latency: 0});
    const {user} = await start(async (input, init) => {
      const url = new URL(String(input), 'http://fixture.local');
      if (['/api/v1/foods', '/api/v1/categories'].includes(url.pathname)) url.searchParams.set('limit', '2');
      return fixture.fetch(url, init);
    }, '/menu?page=2&available=true');
    expect(await screen.findByText('Page 2')).toBeVisible();
    expect(screen.getByRole('button', {name: 'Previous menu page'})).toBeEnabled();
    expect(screen.getByRole('button', {name: 'Next menu page'})).toBeDisabled();
    expect(screen.getByRole('option', {name: 'Pork'})).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Previous menu page'}));
    expect(await screen.findByText('Page 1')).toBeVisible();
    expect(screen.getByRole('button', {name: 'Next menu page'})).toBeEnabled();
    await user.click(screen.getByRole('button', {name: 'Next menu page'}));
    expect(await screen.findByText('Page 2')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Availability filter'), 'false');
    expect(await screen.findByRole('heading', {name: 'Development skewers'})).toBeVisible();
    expect(screen.getByLabelText('Current route')).toHaveTextContent('available=false');
    expect(screen.getByLabelText('Current route')).not.toHaveTextContent('page=2');
  });

  it('ignores an obsolete list response after newer filters finish loading', async () => {
    const fixture = createFixtureTransport({latency: 0});
    let release!: (response: Response) => void;
    let first: Response;
    const {user} = await start(async (input, init) => {
      if (String(input).includes('/foods?') && !String(input).includes('q=')) {
        first = await fixture.fetch(input, {...init, signal: undefined});
        return new Promise<Response>(resolve => {release = resolve;});
      }
      return fixture.fetch(input, init);
    });
    expect(await screen.findByText('Loading menu...')).toBeVisible();
    await waitFor(() => expect(release).toBeDefined());
    await user.type(screen.getByLabelText('Search menu'), 'missing');
    expect(await screen.findByText('No foods match these filters.')).toBeVisible();
    await act(async () => release(first));
    expect(screen.queryByRole('heading', {name: 'Beef Caldereta'})).not.toBeInTheDocument();
    expect(screen.getByText('No foods match these filters.')).toBeVisible();
  });

  it('confirms before closing an unresolved save and keeps its exact request retryable from the menu', async () => {
    const fixture = createFixtureTransport({latency: 0});
    let offline = true;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (offline && String(input).endsWith('/foods') && init?.method === 'POST') throw new TypeError('offline');
      return fixture.fetch(input, init);
    });
    const {user} = await start(transport);
    await user.click(await screen.findByRole('button', {name: 'Add food'})); await fillFood(user);
    await user.click(screen.getByRole('button', {name: 'Save food'}));
    await screen.findByText(/Save result unconfirmed/);
    await user.keyboard('{Escape}');
    expect(screen.getByText(/still unresolved/)).toBeVisible();
    await user.click(screen.getByRole('button', {name: 'Keep editing'}));
    expect(screen.getByLabelText('Food name')).toHaveValue('New dish');
    await user.keyboard('{Escape}'); await user.click(screen.getByRole('button', {name: 'Discard changes'}));
    expect(screen.getByRole('button', {name: 'Add food'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Check previous save'}));
    offline = false; await user.click(await screen.findByRole('button', {name: 'Retry original save'}));
    expect(await screen.findByText('Previous menu save confirmed.')).toBeVisible();
    expect(await screen.findByRole('heading', {name: 'New dish'})).toBeVisible();
    const calls = transport.mock.calls.filter(([input, init]) => String(input).endsWith('/foods') && init?.method === 'POST');
    expect(calls).toHaveLength(2);
    expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
    expect(new Headers(calls[0][1]?.headers).get('Idempotency-Key')).toBe(new Headers(calls[1][1]?.headers).get('Idempotency-Key'));
    expect(sessionStorage.length).toBe(0);
  });
});
