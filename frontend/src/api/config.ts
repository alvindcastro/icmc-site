export type ApiConfig = { mode: 'live' | 'fixtures'; baseUrl: string };
export type ApiEnvironment = { DEV: boolean; VITE_API_MODE?: string; VITE_API_BASE_URL?: string };

export function readApiConfig(env: ApiEnvironment): ApiConfig {
  const mode = env.VITE_API_MODE ?? 'live';
  if (mode !== 'live' && mode !== 'fixtures') throw new Error('Unknown API mode.');
  if (mode === 'fixtures' && !env.DEV) throw new Error('Fixtures are development-only.');
  const baseUrl = (env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/+$/, '');
  if (!/^\/(?!\/)[\w/-]+$/.test(baseUrl) && !/^https?:\/\/[^\s?#]+$/.test(baseUrl)) {
    throw new Error('API base URL must be an absolute HTTP URL or a local path.');
  }
  return { mode, baseUrl };
}
