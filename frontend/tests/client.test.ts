import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client';

const errorResponse = (status: number, code: string) => new Response(JSON.stringify({
  error: { code, message: 'Request failed.', request_id: 'r1',
    field_errors: [{ path: '/username', code: 'required', message: 'Enter a username.' }], details: {} },
}), { status, headers: { 'Content-Type': 'application/json' } });

describe('cookie/CSRF API boundary', () => {
  it('uses configured live URLs and sends cookies without storing credentials', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('{"version":1}'));
    const client = createApiClient({ baseUrl: '/api/v1', transport });
    await expect(client.request('/settings')).resolves.toEqual({ version: 1 });
    expect(transport).toHaveBeenCalledWith('/api/v1/settings', expect.objectContaining({ credentials: 'include' }));
    expect(localStorage.length).toBe(0);
  });

  it('gets a CSRF token for mutation and includes an explicit operation ID', async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(new Response('{"csrf_token":"preauth-token"}'))
      .mockResolvedValueOnce(new Response('{"id":"order1"}', { status: 201 }));
    const client = createApiClient({ baseUrl: '/api/v1', transport });
    await client.request('/orders', { method: 'POST', body: { quantity: 2 }, operationId: 'operation1' });
    const init = transport.mock.calls[1][1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('preauth-token');
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('operation1');
    expect(init.body).toBe('{"quantity":2}');
  });

  it('exposes field errors and expiry, but wrong credentials do not expire a session', async () => {
    const transport = vi.fn().mockResolvedValue(errorResponse(401, 'invalid_credentials'));
    const client = createApiClient({ baseUrl: '/api/v1', transport });
    client.setCsrfToken('token');
    const expired = vi.fn();
    client.onSessionExpired(expired);
    await expect(client.request('/auth/sign-in', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 401, code: 'invalid_credentials', fieldErrors: [expect.objectContaining({ path: '/username' })],
    });
    expect(expired).not.toHaveBeenCalled();
    transport.mockResolvedValue(errorResponse(401, 'session_expired'));
    await expect(client.request('/settings')).rejects.toMatchObject({ code: 'session_expired' });
    expect(expired).toHaveBeenCalledOnce();
  });

  it.each(['network', 'server'])('never retries or queues a mutation after a %s failure', async (failure) => {
    const transport = vi.fn();
    if (failure === 'network') transport.mockRejectedValue(new TypeError('Connection lost'));
    else transport.mockResolvedValue(errorResponse(503, 'temporarily_unavailable'));
    const client = createApiClient({ baseUrl: '/api/v1', transport });
    client.setCsrfToken('token');
    await expect(client.request('/orders', { method: 'POST', body: {}, operationId: 'op1' }))
      .rejects.toMatchObject({ uncertain: true });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('handles empty sign-out responses and discards CSRF after clearing credentials', async () => {
    const transport = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createApiClient({ baseUrl: '/api/v1', transport });
    client.setCsrfToken('old-token');
    await expect(client.request('/auth/sign-out', { method: 'POST', body: {} })).resolves.toBeUndefined();
    client.clearCredentials();
    transport.mockResolvedValueOnce(new Response('{"csrf_token":"new-token"}'));
    await client.request('/auth/sign-out', { method: 'POST', body: {} });
    expect(new Headers(transport.mock.calls[2][1].headers).get('X-CSRF-Token')).toBe('new-token');
  });

  it('drops a CSRF token the server refused, so the next attempt fetches a fresh one', async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(errorResponse(403, 'csrf_invalid'))
      .mockResolvedValueOnce(new Response('{"csrf_token":"fresh-token"}'))
      .mockResolvedValueOnce(new Response('{"signed_in":true}'));
    const client = createApiClient({ baseUrl: '/api/v1', transport });
    client.setCsrfToken('stale-token');
    await expect(client.request('/auth/sign-in', { method: 'POST', body: {} }))
      .rejects.toMatchObject({ status: 403, code: 'csrf_invalid', uncertain: false });
    // The refused request is never resent on its own; staff decide to try again.
    expect(transport).toHaveBeenCalledOnce();
    await expect(client.request('/auth/sign-in', { method: 'POST', body: {} })).resolves.toEqual({ signed_in: true });
    expect(transport.mock.calls[1][0]).toBe('/api/v1/auth/csrf');
    expect(new Headers(transport.mock.calls[2][1].headers).get('X-CSRF-Token')).toBe('fresh-token');
  });

  it('keeps a newer CSRF token when an older request is refused late', async () => {
    let refuse!: (response: Response) => void;
    const transport = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { refuse = resolve; }))
      .mockResolvedValue(new Response('{"saved":true}'));
    const client = createApiClient({ baseUrl: '/api/v1', transport });
    client.setCsrfToken('old-token');
    const late = client.request('/orders', { method: 'POST', body: {}, operationId: 'op1' });
    const refused = expect(late).rejects.toMatchObject({ code: 'csrf_invalid' });
    client.setCsrfToken('current-token');
    refuse(errorResponse(403, 'csrf_invalid'));
    await refused;
    await client.request('/orders', { method: 'POST', body: {}, operationId: 'op2' });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(new Headers(transport.mock.calls[1][1].headers).get('X-CSRF-Token')).toBe('current-token');
  });

  it('rejects malformed successful JSON as a protocol error', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('not json'));
    const client = createApiClient({ baseUrl: '/api/v1', transport });
    await expect(client.request('/settings')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('cancels a mutation still waiting for CSRF when its session ends', async () => {
    let resolveToken!: (response: Response) => void;
    const transport = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { resolveToken = resolve; }));
    const client = createApiClient({ baseUrl: '/api/v1', transport });
    const submission = client.request('/orders', { method: 'POST', body: {}, operationId: 'op1' });
    const rejected = expect(submission).rejects.toMatchObject({ code: 'request_cancelled', uncertain: false });
    client.clearCredentials();
    transport.mockResolvedValue(new Response('{"id":"should-not-exist"}'));
    resolveToken(new Response('{"csrf_token":"obsolete-token"}'));
    await rejected;
    expect(transport).toHaveBeenCalledOnce();
  });

  it('follows the server clock reported with responses', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('{}', { headers: { Date: new Date(Date.now() - 600000).toUTCString() } }));
    const client = createApiClient({ baseUrl: '/api/v1', transport });
    expect(Math.abs(client.now() - Date.now())).toBeLessThan(50);
    await client.request('/settings');
    expect(Math.abs(client.now() - (Date.now() - 600000))).toBeLessThan(2000);
  });
});
