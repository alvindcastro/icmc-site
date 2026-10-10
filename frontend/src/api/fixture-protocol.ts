import type { Operation } from './types';
export type FixtureOperations = Map<string, {fingerprint: string; body: unknown; status: number; operation: Operation}>;
export const canonicalFixture = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
