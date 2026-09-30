import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['.next/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/lib/db/pool',
              message:
                'Use withTenant() from @/lib/db/tenant. Direct pool access skips the tenant GUC.',
            },
            {
              name: '@/lib/db/owner',
              message: 'The owner connection is for migrations and seed only.',
            },
          ],
        },
      ],
    },
  },
];
