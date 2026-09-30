import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';
export default ts.config(
  {
    ignores: [
      '.pnpm-store/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '.tools/**',
      '.runtime/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // A name starting with an underscore says "this exists only to be thrown away" -- it is
      // how a key is taken out of an object with rest, and it is not an oversight.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
