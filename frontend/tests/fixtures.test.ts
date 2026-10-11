import { describe, expect, it } from 'vitest';
import { createFixtureTransport } from '../src/api/fixtures';
import { createApiClient } from '../src/api/client';

describe('explicit development fixtures', () => {
  it('starts signed out, accepts only documented fixture credentials, and exposes provisional settings', async () => {
    const fixture = createFixtureTransport({ latency: 0 });
    const client = createApiClient({ baseUrl: '/api/v1', transport: fixture.fetch });
    await expect(client.request('/auth/session')).rejects.toMatchObject({ status: 401 });
    await expect(client.request('/auth/sign-in', { method: 'POST', body: { username: 'admin', token: 'wrong' } }))
      .rejects.toMatchObject({ code: 'invalid_credentials' });
    const session = await client.request<{ csrf_token: string }>('/auth/sign-in', {
      method: 'POST', body: { username: 'admin', token: 'local-admin-token' },
    });
    client.setCsrfToken(session.csrf_token);
    await expect(client.request('/settings')).resolves.toMatchObject({
      environment: 'development', confirmation: { currency: false, timezone: false }, capabilities: { orders: true },
    });
    await client.request('/auth/sign-out', { method: 'POST', body: {} });
    await expect(client.request('/settings')).rejects.toMatchObject({ status: 401 });
  });

  it('expires a session and rejects unimplemented workflows instead of inventing successful responses', async () => {
    const fixture = createFixtureTransport({ latency: 0 });
    const client = createApiClient({ baseUrl: '/api/v1', transport: fixture.fetch });
    const session = await client.request<{ csrf_token: string }>('/auth/sign-in', {
      method: 'POST', body: { username: 'admin', token: 'local-admin-token' },
    });
    client.setCsrfToken(session.csrf_token);
    await expect(client.request('/reports/daily')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(client.request('/preparations/preview', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 403 });
    fixture.expire();
    await expect(client.request('/settings')).rejects.toMatchObject({ code: 'session_expired' });
  });

  it('rejects another account, password-based login, and a whitespace-altered token', async () => {
    const fixture = createFixtureTransport({ latency: 0 });
    const client = createApiClient({ baseUrl: '/api/v1', transport: fixture.fetch });
    for (const body of [
      { username: 'staff', token: 'local-admin-token' },
      { username: 'admin', password: 'local-admin-token' },
      { username: 'admin', token: ' local-admin-token ' },
      { username: 'demo.staff', password: 'local-demo' },
    ]) {
      await expect(client.request('/auth/sign-in', { method: 'POST', body }))
        .rejects.toMatchObject({ code: 'invalid_credentials' });
    }
  });
});
