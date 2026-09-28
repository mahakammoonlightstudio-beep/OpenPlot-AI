import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 4000
  }
  // NOTE: do NOT exclude highlight.js from optimizeDeps — it is pure CJS and
  // needs esbuild's pre-bundle interop in dev. The dev cold-start win comes
  // from importing 'highlight.js/lib/core' + 13 languages instead of the
  // 386-language barrel, which shrinks what esbuild has to pre-bundle.
});
