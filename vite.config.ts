import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The renderer never talks to the network itself — every request goes through
 * the preload bridge to the main process. A build-time CSP therefore costs
 * nothing and becomes the second line of defence behind DOMPurify: even HTML
 * that somehow bypasses sanitisation cannot load a script, open a socket or
 * exfiltrate through an injected subresource.
 *
 * Applied to the build only: the Vite dev server injects inline scripts for
 * HMR/React Refresh, which a strict policy would block.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Inline style attributes are used by the UI itself (widths, colours).
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // No renderer-side network at all — everything is an IPC call.
  "connect-src 'none'",
  "media-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'openplot-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `  <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n  </head>`
      );
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), cspPlugin()],
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 4000
  },
  server: {
    // Pre-transform the screens the app opens on while Electron is still
    // starting. A cold dev server costs ~1-3 s per module here, so warming the
    // entry graph keeps the first window from spending ~30 s on transforms.
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/App.tsx',
        './src/components/ChatView.tsx',
        './src/components/SettingsView.tsx',
        './src/components/Sidebar.tsx'
      ]
    }
  }
  // NOTE: do NOT exclude highlight.js from optimizeDeps — it is pure CJS and
  // needs esbuild's pre-bundle interop in dev. The dev cold-start win comes
  // from importing 'highlight.js/lib/core' + 13 languages instead of the
  // 386-language barrel, which shrinks what esbuild has to pre-bundle.
});
