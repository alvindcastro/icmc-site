import path from 'node:path';
import {defineConfig} from 'vitest/config';

// The conformance run: the fixture contract tests, with the in-memory fixture exchanged for the real backend.
export default defineConfig({
  resolve: {alias: [{find: /^\.\.\/src\/api\/fixtures$/, replacement: path.resolve(import.meta.dirname, 'tests/conformance/live-fixtures.ts')}]},
  test: {
    environment: 'node',
    include: ['tests/*fixtures*.test.ts', 'tests/conformance/*.live.ts'],
    globalSetup: ['./tests/conformance/server.ts'],
    env: {CONFORMANCE: '1'},
    restoreMocks: true,
    testTimeout: 30000,
  },
});
