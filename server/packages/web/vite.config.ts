import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  // Relative base so the built assets work when the API serves them from
  // behind a reverse proxy mounted at an arbitrary path, not just '/'.
  base: './',
  build: {
    outDir: '../ui-dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
