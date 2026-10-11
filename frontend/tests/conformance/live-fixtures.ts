// Stands in for src/api/fixtures during the conformance run: the same `createFixtureTransport`,
// but every request goes to the real backend. Each transport gets its own "world" on the
// conformance server (backend/tests/conformance_server.py): a new database seeded like the
// fixture, so the fixture contract tests can run unchanged against the server.
import {createHash} from 'node:crypto';
import {inject} from 'vitest';
import type {FetchTransport} from '../../src/api/types';

// The real network, kept before any test replaces a global.
const network = globalThis.fetch;
const origin = 'http://conformance.local';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function control(path: string, body?: unknown): Promise<any> {
  const response = await network(`${inject('conformanceUrl')}/__conformance__${path}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body ?? {})});
  if (!response.ok) throw new Error(`The conformance server refused ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export function createFixtureTransport(options: {latency?: number; samples?: boolean; preparation?: boolean} = {}): {fetch: FetchTransport; expire: () => void} {
  // The placeholder recipes are development data of the fixture alone and are never loaded into a server.
  if (options.samples) throw new Error('Sample recipes exist only in the in-memory fixture.');
  const world: Promise<string> = control('/worlds', {preparation: Boolean(options.preparation)}).then(created => created.world);
  let settled: Promise<unknown> = world;
  const cookies = new Map<string, string>();
  // The server accepts only UUIDs as operation keys; the tests use readable ones. Each readable key is
  // exchanged for a UUID of its own on the way out and put back on the way in.
  const keys = new Map<string, string>();
  const keyFor = (readable: string) => {
    if (uuid.test(readable)) return readable;
    const hex = createHash('sha256').update(readable).digest('hex');
    const mapped = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    keys.set(readable, mapped);
    return mapped;
  };
  return {
    expire() { settled = settled.then(async () => control(`/worlds/${await world}/expire`)); },
    async fetch(input, init) {
      await settled;
      const url = new URL(String(input), inject('conformanceUrl'));
      const lookup = /^(\/api\/v1\/operations\/)([^/]+)$/.exec(url.pathname);
      if (lookup) url.pathname = lookup[1] + encodeURIComponent(keyFor(decodeURIComponent(lookup[2])));
      const headers = new Headers(init?.headers);
      const key = headers.get('Idempotency-Key');
      if (key) headers.set('Idempotency-Key', keyFor(key));
      headers.set('Origin', origin);
      headers.set('X-Conformance-World', await world);
      // The server's clock follows this test's clock, so moving one moves the other.
      headers.set('X-Conformance-Now', String(Date.now()));
      if (cookies.size) headers.set('Cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
      const response = await network(url, {method: init?.method, headers, body: init?.body, signal: init?.signal});
      for (const cookie of response.headers.getSetCookie()) {
        const [pair, ...attributes] = cookie.split(';');
        const [name, value] = [pair.slice(0, pair.indexOf('=')).trim(), pair.slice(pair.indexOf('=') + 1).trim()];
        if (!value || attributes.some(attribute => /^\s*max-age=0\s*$/i.test(attribute))) cookies.delete(name); else cookies.set(name, value);
      }
      if (response.status === 204) return new Response(null, {status: 204, headers: response.headers});
      let text = await response.text();
      for (const [readable, mapped] of keys) text = text.replaceAll(mapped, readable);
      return new Response(text, {status: response.status, headers: {'Content-Type': response.headers.get('Content-Type') ?? 'application/json', Date: response.headers.get('Date') ?? ''}});
    },
  };
}
