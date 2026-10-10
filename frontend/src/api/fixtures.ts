import type { BusinessSettings, FetchTransport, StaffSession } from './types';
import { createMenuFixtures } from './menu-fixtures';
import { createOrderFixtures } from './order-fixtures';
import { createInventoryFixtures } from './inventory-fixtures';
import { createRecipeFixtures } from './recipe-fixtures';
import { seedSampleRecipes } from './sample-recipes';
import type { FixtureOperations } from './fixture-protocol';

const settings: BusinessSettings = {
  version: 1, environment: 'development',
  confirmation: { currency: false, timezone: false, fulfillment: false, delivery: false, tax: false, confirmed_at: null },
  currency: 'USD', minor_digits: 2, timezone: 'America/Los_Angeles',
  fulfillment_methods: ['pickup', 'delivery'], pickup_location: null,
  delivery_policy: { mode: 'manual_amount', fixed_charge_minor: null },
  tax_policy: { mode: 'manual_amount', inclusive: false }, payment_methods: ['cash', 'bank_transfer', 'other'],
  capabilities: { orders: true, menu: true, payments: true, inventory: true, purchases: true, recipes: true, planning: false, preparation_recording: false },
};

export function createFixtureTransport(options: { latency?: number; samples?: boolean } = {}): { fetch: FetchTransport; expire: () => void } {
  let session: StaffSession | null = null;
  let expired = false;
  let csrfToken = crypto.randomUUID();
  const usedVariants = new Set<string>();
  const operations: FixtureOperations = new Map();
  const recipeIds = new Map<string, string>();
  const menu = createMenuFixtures({usedVariants, operations, recipeIds});
  const orders = createOrderFixtures({menu, settings, usedVariants, operations});
  const inventory = createInventoryFixtures(settings, operations);
  const recipes = createRecipeFixtures({menu, inventory, settings, recipeIds});
  // Placeholder ingredients, one receipt and recipes are opt-in; the default fixture starts empty.
  const seeded = options.samples ? seedSampleRecipes({menu, inventory, recipes}) : Promise.resolve();
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const failure = (status: number, code: string, message: string) => json({
    error: { code, message, request_id: 'development-fixture', field_errors: [], details: {} },
  }, status);

  return {
    expire() { session = null; expired = true; },
    async fetch(input, init) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.latency ?? 180);
        const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
      await seeded;
      const url = new URL(String(input), 'http://fixture.local');
      const path = url.pathname;
      const method = init?.method ?? 'GET';
      if (session && Date.now() >= Math.min(Date.parse(session.idle_expires_at), Date.parse(session.absolute_expires_at))) {
        session = null; expired = true;
      }
      if (path === '/api/v1/auth/csrf' && method === 'GET') return json({ csrf_token: csrfToken });
      if (!['GET', 'HEAD'].includes(method) && new Headers(init?.headers).get('X-CSRF-Token') !== csrfToken) {
        return failure(403, 'csrf_invalid', 'Refresh the sign-in token and try again.');
      }
      if (path === '/api/v1/auth/sign-in' && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        if (body.username !== 'admin' || body.token !== 'local-admin-token') {
          return failure(401, 'invalid_credentials', 'The username or token is incorrect.');
        }
        csrfToken = crypto.randomUUID();
        session = {
          user: { id: 'fixture_admin', username: 'admin', display_name: 'Admin', role: 'staff' },
          csrf_token: csrfToken, idle_expires_at: new Date(Date.now() + 1800000).toISOString(),
          absolute_expires_at: new Date(Date.now() + 43200000).toISOString(),
        };
        expired = false;
        return json(session);
      }
      if (path === '/api/v1/auth/sign-out' && method === 'POST') {
        session = null; expired = false; csrfToken = crypto.randomUUID();
        return new Response(null, { status: 204 });
      }
      if (!session) return failure(401, expired ? 'session_expired' : 'unauthenticated', 'Sign in to continue.');
      if (path === '/api/v1/auth/session' && method === 'GET') return json(session);
      if (path === '/api/v1/settings' && method === 'GET') {
        session.idle_expires_at = new Date(Math.min(Date.now() + 1800000, Date.parse(session.absolute_expires_at))).toISOString();
        return json(settings);
      }
      const response = await inventory(url, init) ?? await recipes(url, init) ?? await orders(url, init) ?? await menu(url, init);
      if (response) {
        session.idle_expires_at = new Date(Math.min(Date.now() + 1800000, Date.parse(session.absolute_expires_at))).toISOString();
        return response;
      }
      return failure(404, 'not_found', 'This workflow is not available.');
    },
  };
}
