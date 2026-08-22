import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `packages/*/ui/src` is the browser-targeted UI tree (packages/web/ui);
    // its pure, DOM-free helpers are unit-tested like anything else.
    include: ['packages/*/src/**/*.test.ts', 'packages/*/ui/src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
  },
});
