import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { useData, useSettings } from './store';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// E2E/test hook: expose the data store for CDP scripts (scripts/*-test.mjs).
// Harmless in production — read-only reference on window.
(window as any).useData = useData;
(window as any).useSettings = useSettings;

// Delegated handler for copy buttons inside rendered markdown code blocks
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const btn = target.closest?.('.md-copy') as HTMLElement | null;
  if (btn) {
    const code = decodeURIComponent(btn.getAttribute('data-code') || '');
    navigator.clipboard.writeText(code).then(() => {
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1200);
    });
  }
});
