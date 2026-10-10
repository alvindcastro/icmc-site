import { describe, expect, it } from 'vitest';
import { readApiConfig } from '../src/api/config';

describe('explicit API mode', () => {
  it('defaults to live requests with no implicit fixture fallback', () => {
    expect(readApiConfig({ DEV: true })).toEqual({ mode: 'live', baseUrl: '/api/v1' });
  });

  it('allows explicit development fixtures and normalizes the base URL', () => {
    expect(readApiConfig({ DEV: true, VITE_API_MODE: 'fixtures', VITE_API_BASE_URL: '/api/v1/' }))
      .toEqual({ mode: 'fixtures', baseUrl: '/api/v1' });
  });

  it('rejects fixtures in a production build', () => {
    expect(() => readApiConfig({ DEV: false, VITE_API_MODE: 'fixtures' })).toThrow(/development/i);
  });

  it.each(['mock', '', 'javascript:alert(1)', '//untrusted.example'])('rejects invalid mode or base URL %s', (value) => {
    const env = value === 'mock' || value === ''
      ? { DEV: true, VITE_API_MODE: value }
      : { DEV: true, VITE_API_BASE_URL: value };
    expect(() => readApiConfig(env)).toThrow();
  });
});
