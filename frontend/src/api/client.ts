import type { FetchTransport, FieldError } from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string,
    public fieldErrors: FieldError[] = [], public uncertain = false,
    public details: Record<string, unknown> = {}) { super(message); }
}

type RequestOptions = { method?: string; body?: unknown; operationId?: string; signal?: AbortSignal };
export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(options: { baseUrl: string; transport?: FetchTransport }) {
  const transport = options.transport ?? fetch;
  let csrfToken: string | null = null;
  let csrfRequest: Promise<string> | null = null;
  let credentialVersion = 0;
  let clockOffset = 0;
  const expiredHandlers = new Set<() => void>();
  const controllers = new Set<AbortController>();

  async function send<T>(path: string, request: RequestOptions = {}): Promise<T> {
    const method = request.method ?? 'GET';
    const mutation = !['GET', 'HEAD'].includes(method);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    controllers.add(controller);
    const headers = new Headers({ Accept: 'application/json' });
    if (request.body !== undefined) headers.set('Content-Type', 'application/json');
    const sentToken = mutation ? csrfToken : null;
    if (sentToken) headers.set('X-CSRF-Token', sentToken);
    if (request.operationId) headers.set('Idempotency-Key', request.operationId);
    try {
      const response = await transport(`${options.baseUrl}${path}`, {
        method, headers, credentials: 'include', cache: 'no-store',
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal,
      });
      // Expiry times are the server's; follow its clock so a wrong device clock cannot end sessions or quotes early.
      const serverTime = Date.parse(response.headers.get('Date') ?? '');
      if (Number.isFinite(serverTime)) clockOffset = serverTime - Date.now();
      if (response.status === 204) return undefined as T;
      let payload;
      try { payload = await response.json(); }
      catch { throw new ApiError(response.status, 'invalid_response', 'The server returned an unreadable response.', [], mutation); }
      if (!response.ok) {
        const error = payload?.error;
        const code = typeof error?.code === 'string' ? error.code : 'request_failed';
        // A refused token is useless: forget it so the next attempt fetches a fresh one. Nothing is resent here.
        if (code === 'csrf_invalid' && csrfToken === sentToken) csrfToken = null;
        if (response.status === 401 && code !== 'invalid_credentials') {
          expiredHandlers.forEach(handler => handler());
        }
        throw new ApiError(response.status, code,
          typeof error?.message === 'string' ? error.message : 'The request could not be completed.',
          Array.isArray(error?.field_errors) ? error.field_errors : [], mutation && response.status >= 500,
          error?.details && typeof error.details === 'object' ? error.details : {});
      }
      return payload as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(0, 'connection_error', 'Cannot reach the server. Check the connection and try again.', [], mutation);
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }

  return {
    async request<T = unknown>(path: string, request: RequestOptions = {}): Promise<T> {
      const requestVersion = credentialVersion;
      if (request.method && !['GET', 'HEAD'].includes(request.method) && !csrfToken) {
        if (!csrfRequest) {
          const pending = send<{ csrf_token: string }>('/auth/csrf').then(result => {
            if (requestVersion !== credentialVersion) throw new ApiError(0, 'request_cancelled', 'The session ended before submission.');
            if (!result?.csrf_token) throw new ApiError(200, 'invalid_response', 'A sign-in token could not be obtained.');
            csrfToken = result.csrf_token;
            return csrfToken;
          }).finally(() => { if (csrfRequest === pending) csrfRequest = null; });
          csrfRequest = pending;
        }
        await csrfRequest;
      }
      if (requestVersion !== credentialVersion) throw new ApiError(0, 'request_cancelled', 'The session ended before submission.');
      return send<T>(path, request);
    },
    setCsrfToken(token: string) { csrfToken = token; },
    now(): number { return Date.now() + clockOffset; },
    clearCredentials() {
      credentialVersion++;
      csrfToken = null;
      csrfRequest = null;
      controllers.forEach(controller => controller.abort());
    },
    onSessionExpired(handler: () => void): () => void {
      expiredHandlers.add(handler);
      return () => { expiredHandlers.delete(handler); };
    },
  };
}
