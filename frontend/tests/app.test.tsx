import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { createApiClient } from '../src/api/client';
import { createFixtureTransport } from '../src/api/fixtures';
import { protectedData } from '../src/auth/protected-data';
import { behindServer, sampleSession, sampleSettings } from './helpers';

function start(path = '/', transport = createFixtureTransport({ latency: 0 }).fetch) {
  const client = createApiClient({ baseUrl: '/api/v1', transport });
  render(<MemoryRouter initialEntries={[path]}><App client={client} mode="fixtures" /></MemoryRouter>);
  return { client, user: userEvent.setup() };
}
async function login(user: ReturnType<typeof userEvent.setup>) {
  expect(await screen.findByLabelText('Username')).toHaveValue('admin');
  await user.type(screen.getByLabelText('Token'), 'local-admin-token');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('foundation and staff session', () => {
  it('protects routes and returns to the requested screen after sign-in', async () => {
    const { user } = start('/account');
    await login(user);
    expect(await screen.findByRole('heading', { name: 'My account' })).toBeVisible();
    expect(screen.getAllByText('Admin').length).toBeGreaterThan(0);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('prefills admin, validates the token, and has an accessible token visibility control', async () => {
    const { user } = start();
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(screen.getByLabelText('Username')).toHaveValue('admin');
    expect(screen.getByLabelText('Token')).toHaveFocus();
    expect(screen.getByText('Enter your token.')).toBeVisible();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Username'));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByLabelText('Username')).toHaveFocus();
    expect(screen.getByText('Enter your username.')).toBeVisible();
    await user.type(screen.getByLabelText('Token'), 'secret');
    expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show token' }));
    expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide token' }));
    expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
  });

  it('retains username on failed credentials and retries connection errors explicitly', async () => {
    const fixture = createFixtureTransport({ latency: 0 });
    let offline = false;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (offline && String(input).endsWith('/auth/sign-in')) throw new TypeError('offline');
      return fixture.fetch(input, init);
    });
    const { user } = start('/', transport);
    await screen.findByLabelText('Username');
    await user.type(screen.getByLabelText('Token'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/username or token/i);
    expect(screen.getByLabelText('Username')).toHaveValue('admin');
    await user.clear(screen.getByLabelText('Token'));
    await user.type(screen.getByLabelText('Token'), 'local-admin-token');
    offline = true;
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('button', { name: 'Retry sign-in' })).toBeVisible();
    offline = false;
    await user.click(screen.getByRole('button', { name: 'Retry sign-in' }));
    expect(await screen.findByRole('heading', { name: 'Workspace' })).toBeVisible();
  });

  it('shows provisional business settings and exposes only delivered navigation', async () => {
    const { user } = start();
    await login(user);
    expect(await screen.findByText('USD')).toBeVisible();
    expect(screen.getByText('America/Los_Angeles')).toBeVisible();
    expect(screen.getByText('Provisional business settings')).toBeVisible();
    expect(screen.getByRole('link', {name: 'Orders'})).toBeVisible();
    expect(screen.getByRole('link', {name: 'Dashboard'})).toBeVisible();
    expect(screen.getByRole('link', {name: 'Ingredients'})).toBeVisible();
    expect(screen.getByRole('link', {name: 'Purchases'})).toBeVisible();
    expect(screen.getByRole('link', { name: 'Menu & Recipes' })).toBeVisible();
    expect(screen.queryByRole('link', { name: /planning|preparation|shopping/i })).not.toBeInTheDocument();
  });

  it('clears protected data on expiry and never repeats an expired mutation after signing in', async () => {
    const fixture = createFixtureTransport({ latency: 0 });
    const transport = vi.fn(fixture.fetch);
    const { user, client } = start('/account', transport);
    await login(user);
    await screen.findByRole('heading', { name: 'My account' });
    protectedData.set('draft', { customer: 'Sensitive Customer' });
    fixture.expire();
    await act(async () => {
      await expect(client.request('/orders', { method: 'POST', body: {}, operationId: 'op1' }))
        .rejects.toMatchObject({ status: 401 });
    });
    expect(await screen.findByText(/session expired/i)).toBeVisible();
    expect(protectedData.size).toBe(0);
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
    await login(user);
    await screen.findByRole('heading', { name: 'My account' });
    expect(transport.mock.calls.filter(([input, init]) => String(input).endsWith('/orders') && init?.method === 'POST')).toHaveLength(1);
  });

  it('clears data immediately on sign-out and blocks sign-in until uncertain remote sign-out is retried', async () => {
    const fixture = createFixtureTransport({ latency: 0 });
    let failed = true;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failed && String(input).endsWith('/auth/sign-out')) throw new TypeError('offline');
      return fixture.fetch(input, init);
    });
    const { user } = start('/', transport);
    await login(user);
    await screen.findByText('USD');
    protectedData.set('private', 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Retry sign-out' })).toBeVisible();
    expect(protectedData.size).toBe(0);
    expect(screen.queryByText('USD')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    failed = false;
    await user.click(screen.getByRole('button', { name: 'Retry sign-out' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled());
  });

  it('does not repopulate protected settings from a response arriving after sign-out', async () => {
    let resolveSettings!: (response: Response) => void;
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/session')) return new Response(JSON.stringify(sampleSession()));
      if (path.endsWith('/settings')) return new Promise<Response>(resolve => { resolveSettings = resolve; });
      if (path.endsWith('/auth/csrf')) return new Response('{"csrf_token":"token"}');
      return new Response(null, { status: 204 });
    });
    const { user } = start('/', transport);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('Username');
    await act(async () => { resolveSettings(new Response(JSON.stringify(sampleSettings))); });
    expect(screen.queryByText('USD')).not.toBeInTheDocument();
  });

  it('recovers a settings failure without signing out or inventing default settings', async () => {
    const fixture = createFixtureTransport({ latency: 0 });
    let failed = true;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failed && String(input).endsWith('/settings')) throw new TypeError('offline');
      return fixture.fetch(input, init);
    });
    const { user } = start('/', transport);
    await login(user);
    expect(await screen.findByRole('button', { name: 'Retry business settings' })).toBeVisible();
    expect(screen.queryByText('USD')).not.toBeInTheDocument();
    failed = false;
    await user.click(screen.getByRole('button', { name: 'Retry business settings' }));
    expect(await screen.findByText('USD')).toBeVisible();
  });

  it('rejects an external return route and recovers a session-check connection error', async () => {
    const fixture = createFixtureTransport({ latency: 0 });
    let failed = true;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failed && String(input).endsWith('/auth/session')) throw new TypeError('offline');
      return fixture.fetch(input, init);
    });
    const { user } = start('/sign-in?returnTo=https://untrusted.example', transport);
    expect(await screen.findByRole('button', { name: 'Retry session check' })).toBeVisible();
    failed = false;
    await user.click(screen.getByRole('button', { name: 'Retry session check' }));
    await login(user);
    expect(await screen.findByRole('heading', { name: 'Workspace' })).toBeVisible();
  });

  it('rejects missing business timezone instead of formatting in browser time', async () => {
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/session')) return new Response(JSON.stringify(sampleSession()));
      const { timezone: _timezone, ...incomplete } = sampleSettings;
      return new Response(JSON.stringify(incomplete));
    });
    start('/', transport);
    expect(await screen.findByRole('button', { name: 'Retry business settings' })).toBeVisible();
    expect(screen.queryByText('USD')).not.toBeInTheDocument();
    expect(screen.getByText('Business timezone unavailable')).toBeVisible();
  });

  it('keeps sign-in pending and prevents a second request while credentials are being checked', async () => {
    const fixture = createFixtureTransport({ latency: 0 });
    let finish!: () => void;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/auth/sign-in')) await new Promise<void>(resolve => { finish = resolve; });
      return fixture.fetch(input, init);
    });
    const { user } = start('/', transport);
    await login(user);
    expect(screen.getByRole('button', { name: 'Signing in...' })).toBeDisabled();
    expect(screen.getByLabelText('Username')).toHaveValue('admin');
    await user.click(screen.getByRole('button', { name: 'Signing in...' }));
    await act(async () => { finish(); });
    await screen.findByRole('heading', { name: 'Workspace' });
    expect(transport.mock.calls.filter(([input]) => String(input).endsWith('/auth/sign-in'))).toHaveLength(1);
  });

  it('sends token credentials without a password and associates server token errors with the field', async () => {
    const transport = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith('/auth/csrf')) return new Response('{"csrf_token":"csrf"}');
      const signIn = String(input).endsWith('/auth/sign-in');
      return new Response(JSON.stringify({ error: {
        code: signIn ? 'validation_failed' : 'unauthenticated', message: 'Check your token.', request_id: 'token-test',
        field_errors: signIn ? [{ path: '/token', code: 'invalid', message: 'Enter a valid token.' }] : [], details: {},
      } }), { status: signIn ? 422 : 401 });
    });
    const { user } = start('/', transport);
    await login(user);
    expect(await screen.findByText('Enter a valid token.')).toBeVisible();
    expect(screen.getByLabelText('Token')).toHaveFocus();
    expect(screen.getByLabelText('Token')).toHaveAttribute('aria-invalid', 'true');
    const submission = transport.mock.calls.find(([input]) => String(input).endsWith('/auth/sign-in'));
    expect(JSON.parse(String(submission?.[1]?.body))).toEqual({ username: 'admin', token: 'local-admin-token' });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps a valid session when the device clock runs ahead of the server', async () => {
    const { user } = start('/', behindServer(createFixtureTransport({ latency: 0 }).fetch, 31 * 60000));
    await login(user);
    expect(await screen.findByText('USD')).toBeVisible();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(screen.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
  });
});
