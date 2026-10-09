// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.js', '**/*.mjs', '**/*.cjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/ui/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./packages/*/tsconfig.json', './packages/*/ui/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Import-direction guard (brief B1): `@homecsi/features` and
    // `@homecsi/occupancy` must never import `@homecsi/box` (the sibling
    // box-experiment package, owned by brief B3). The structural fence that
    // actually keeps box-role CSI out of the house pipeline is the
    // nodes.role join in packages/features/src/pipeline.ts's
    // createPgCsiRecordSource -- this rule is a second, independent
    // guardrail against the box package's own code (session bookkeeping,
    // gesture-classification logic, whatever it grows into) ever being
    // pulled into the two packages that feed occupancy_states, which would
    // make it far too easy for a future change to bypass that fence by
    // reaching for box-experiment data directly instead of through it.
    files: ['packages/features/src/**/*.ts', 'packages/occupancy/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@homecsi/box', '@homecsi/box/*'],
              message:
                '@homecsi/features and @homecsi/occupancy must never import @homecsi/box -- box-experiment CSI is fenced out of the house occupancy pipeline at packages/features/src/pipeline.ts\'s nodes.role join; importing box-package code here would make it too easy to bypass that fence.',
            },
          ],
        },
      ],
    },
  },
);
