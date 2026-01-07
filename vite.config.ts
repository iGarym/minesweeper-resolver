import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  base: '/minesweeper-resolver/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    minify: true,
  },
});
