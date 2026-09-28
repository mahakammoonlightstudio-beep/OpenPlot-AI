import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import DOMPurify from 'dompurify';
import 'highlight.js/styles/github-dark.css';

// PERF: importing the 'highlight.js' barrel pulled in ALL 386 languages
// (~2.3MB) and made every highlightAuto scan them all. We register only the
// languages a writing app actually meets, so cold start and per-chunk
// rendering get dramatically cheaper. Add more as needed:
//   import go from 'highlight.js/lib/languages/go'; hljs.registerLanguage('go', go);
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import markdownLang from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import ini from 'highlight.js/lib/languages/ini';
import plaintext from 'highlight.js/lib/languages/plaintext';
import diff from 'highlight.js/lib/languages/diff';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('diff', diff);

// Aliases models commonly emit — mapped onto registered grammars.
// highlightAuto now only scans the registered set, not 386 languages.
const ALIAS_LANGS: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  sh: 'bash',
  zsh: 'bash',
  html: 'xml',
  svg: 'xml',
  yml: 'yaml',
  text: 'plaintext',
  txt: 'plaintext'
};

// Streaming re-renders the same code block many times as tokens arrive;
// highlight.js is expensive, so cache results by raw code text.
const HL_CACHE = new Map<string, string>();
const HL_CACHE_MAX = 300;
const HL_CACHE_SKIP = 64 * 1024; // don't cache huge blocks
function highlightCached(raw: string, language: string): string {
  const key = language + '\u0000' + raw;
  const hit = HL_CACHE.get(key);
  if (hit !== undefined) return hit;
  let value: string;
  try {
    const lang = ALIAS_LANGS[language] || language;
    value = lang && hljs.getLanguage(lang)
      ? hljs.highlight(raw, { language: lang }).value
      : hljs.highlightAuto(raw).value;
  } catch {
    value = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (raw.length <= HL_CACHE_SKIP) {
    if (HL_CACHE.size >= HL_CACHE_MAX) {
      // drop the oldest entry (insertion order) — keeps memory bounded
      HL_CACHE.delete(HL_CACHE.keys().next().value as string);
    }
    HL_CACHE.set(key, value);
  }
  return value;
}

marked.setOptions({
  gfm: true,
  breaks: true
});

// Custom renderer: code blocks with hljs highlighting + copy button.
// marked v15 uses token-based renderer signatures.
const renderer = new marked.Renderer();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
renderer.code = function (this: any, code: string | any, langOrInfo?: string) {
  // marked v15 passes a token object; older signature passes (code, lang)
  let raw = '';
  let lang = '';
  if (typeof code === 'object' && code !== null) {
    raw = code.text ?? '';
    lang = code.lang ?? '';
  } else {
    raw = String(code ?? '');
    lang = String(langOrInfo ?? '');
  }
  const language = lang ? lang.split(/\s+/)[0] : '';
  const highlighted = highlightCached(raw, language);
  const btn = `<button class="md-copy" data-code="${encodeURIComponent(raw)}">Copy</button>`;
  return `<div class="codeblock"><div class="codeblock-bar"><span>${language || 'text'}</span>${btn}</div><pre><code class="hljs">${highlighted}</code></pre></div>`;
} as any;

// Register the renderer
marked.use({ renderer });

// Sanitizer config: keep markdown output but strip scripts/handlers.
// Allow class/data-code so our own code-block markup survives sanitization.
const PURIFY_CFG = {
  ADD_ATTR: ['target', 'data-code'],
  FORBID_TAGS: ['style', 'form', 'input'],
  FORBID_ATTR: ['style'] // drop inline styles from model output; layout stays ours
};

export function sanitizeHtml(html: string): string {
  if (typeof window === 'undefined') return html;
  return DOMPurify.sanitize(html, PURIFY_CFG);
}

// Post-process sanitized HTML: external links open in OS browser
function hardenLinks(container: HTMLElement): void {
  container.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

function parseAndSanitize(text: string): string {
  try {
    const html = marked.parse(text || '', { async: false }) as string;
    return sanitizeHtml(html);
  } catch {
    return sanitizeHtml(text);
  }
}

export function useMarkdown(text: string): string {
  return useMemo(() => parseAndSanitize(text), [text]);
}

export function renderMarkdownSync(text: string): string {
  return parseAndSanitize(text);
}

// PERF: streaming previously re-parsed the FULL markdown on every token —
// O(n²) over the reply and the main cause of chat jank on long generations.
// This hook re-parses at most once per animation frame while streaming, and
// ALWAYS parses the final text once the stream ends so nothing stays stale.
export function useThrottledMarkdown(text: string, live: boolean): string {
  const [shown, setShown] = useState(() => parseAndSanitize(text));
  useEffect(() => {
    if (!live) {
      setShown(parseAndSanitize(text));
      return;
    }
    const raf = requestAnimationFrame(() => setShown(parseAndSanitize(text)));
    return () => cancelAnimationFrame(raf);
  }, [text, live]);
  return shown;
}

export function extractFirstTitle(text: string): string | null {
  const m = (text || '').match(/<title>([^<]+)<\/title>/i);
  return m ? m[1].trim().slice(0, 80) : null;
}

export { hardenLinks };
