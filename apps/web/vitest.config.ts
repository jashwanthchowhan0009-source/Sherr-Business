import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      // Component tests need a DOM, so they get their own environment below.
      'tests/ui/**/*.test.tsx',
    ],
    environmentMatchGlobs: [['tests/ui/**', 'jsdom']],
    setupFiles: ['tests/setup.ts'],
    // Integration tests share one Postgres database and create/drop rows;
    // running files in parallel would make them flake against each other.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  // The PDF renderer is authored as TSX. Vitest's transform defaults to the
  // classic JSX runtime, which expects React in scope; Next uses the automatic
  // one, so the test environment is told to match the application.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // See tests/stubs/server-only.ts for why.
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
});
