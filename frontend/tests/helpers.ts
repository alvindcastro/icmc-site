import type { BusinessSettings, FetchTransport, StaffSession } from '../src/api/types';

export const sampleSettings: BusinessSettings = {
  version: 1, environment: 'development',
  confirmation: { currency: false, timezone: false, fulfillment: false, delivery: false, tax: false, confirmed_at: null },
  currency: 'USD', minor_digits: 2, timezone: 'America/Los_Angeles',
  fulfillment_methods: ['pickup', 'delivery'], pickup_location: null,
  delivery_policy: { mode: 'manual_amount', fixed_charge_minor: null },
  tax_policy: { mode: 'manual_amount', inclusive: false }, payment_methods: ['cash', 'bank_transfer', 'other'],
  capabilities: { orders: false, menu: false, payments: false, inventory: false, purchases: false, recipes: false, planning: false, preparation_recording: false },
};
export const sampleSession = (): StaffSession => ({
  user: { id: 'fixture_admin', username: 'admin', display_name: 'Admin', role: 'staff' },
  csrf_token: 'session-token', idle_expires_at: new Date(Date.now() + 1800000).toISOString(),
  absolute_expires_at: new Date(Date.now() + 43200000).toISOString(),
});
// Presents a transport as a server whose clock runs `behind` milliseconds earlier than this device's.
export function behindServer(transport: FetchTransport, behind: number): FetchTransport {
  return async (input, init) => {
    const response = await transport(input, init);
    const body = response.status === 204 ? null : (await response.text()).replace(/"((?:idle_|absolute_)?expires_at)":"([^"]+)"/g,
      (_match, key, instant) => `"${key}":"${new Date(Date.parse(instant) - behind).toISOString()}"`);
    return new Response(body, { status: response.status, headers: { 'Content-Type': 'application/json', Date: new Date(Date.now() - behind).toUTCString() } });
  };
}
// True in the conformance run, where the fixture contract tests talk to the real backend. A test that builds
// fixture internals directly has no server to talk to, so it is skipped there with `it.skipIf(conformance)`.
export const conformance = process.env.CONFORMANCE === '1';
