import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, useSettings, useUi } from '../store';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { useMarkdown, hardenLinks } from '../markdown';
import { GUIDE_DOCS, DEFAULT_GUIDE_SLUG } from '../guide';
import {
  articleList, neighbours, resolveArticle, rewriteTokens, searchGuide, parseActionHref,
  type GuideToken
} from '../guide/content';

/**
 * The in-app guide (Task 9).
 *
 * Articles ship as Markdown, so the renderer here stays thin: pick the doc,
 * rewrite `[[settings:…]]` tokens into in-app links, render with the same
 * sanitizing pipeline as chat, and delegate clicks back to the router.
 */
/**
 * marked emits <h2>/<h3> without ids, so the TOC could not jump. The parser
 * already assigned stable ids in document order — attach them here rather than
 * carrying a second renderer just for the guide.
 */
function withHeadingIds(html: string, headings: Array<{ id: string; text: string }>): string {
  if (!headings.length) return html;
  let i = 0;
  return html.replace(/<h([23])>/g, (all, level: string) => {
    const h = headings[i++];
    return h ? `<h${level} id="${h.id}">` : all;
  });
}

export function GuideView() {
  const t = useT();
  const ui = useUi();
  const navigate = useData((s) => s.navigate);
  const slug = useData((s) => s.guideSlug);
  const setSlug = useData((s) => s.setGuideSlug);
  const lang = useSettings((s) => s.lang);
  const [q, setQ] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const list = useMemo(() => articleList(lang, GUIDE_DOCS), [lang]);
  const article = useMemo(
    () => resolveArticle(slug, lang, GUIDE_DOCS) || resolveArticle(DEFAULT_GUIDE_SLUG, lang, GUIDE_DOCS),
    [slug, lang]
  );
  const { prev, next } = neighbours(article?.slug || '', list);
  const hits = useMemo(() => searchGuide(q, list), [q, list]);

  const label = (tok: GuideToken) => {
    if (tok.kind === 'settings') return t('settings.' + tok.target);
    if (tok.kind === 'route') return t('app.' + tok.target) === 'app.' + tok.target ? tok.target : t('app.' + tok.target);
    const doc = list.find((d) => d.slug === tok.target);
    return doc?.title || tok.target;
  };
  const rendered = useMarkdown(article ? rewriteTokens(article.body, label) : '');
  const html = useMemo(() => withHeadingIds(rendered, article?.headings || []), [rendered, article]);

  // Deep link: #guide/<slug> survives a reload and can be shared.
  useEffect(() => {
    if (article) window.history.replaceState(null, '', `#guide/${article.slug}`);
  }, [article?.slug]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [article?.slug]);

  // Sanitized HTML still needs the external-link hardening pass.
  useEffect(() => { if (bodyRef.current) hardenLinks(bodyRef.current); }, [html]);

  function openToken(tok: GuideToken) {
    if (tok.kind === 'settings') {
      useUi.getState().setSettingsSection(tok.target as any);
      navigate('settings');
    } else if (tok.kind === 'route') {
      navigate(tok.target);
    } else {
      setSlug(tok.target);
    }
  }

  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const token = parseActionHref(a.getAttribute('href') || '');
    if (!token) return;
    e.preventDefault();
    openToken(token);
  }

  async function copyLink() {
    if (!article) return;
    const url = `${location.origin}${location.pathname}#guide/${article.slug}`;
    try {
      await navigator.clipboard.writeText(url);
      ui.toast(t('guide.copied'), 'ok');
    } catch {
      ui.toast(t('guide.copyFailed'), 'error');
    }
  }

  return (
    <div className="page guide">
      <div className="page-head">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="book" size={18} /> {t('guide.title')}
          </h1>
          <div className="subtitle">{t('guide.sub')}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="ghost" onClick={() => window.dispatchEvent(new CustomEvent('inkwell:shortcuts'))}>
            {t('guide.shortcuts')}
          </button>
          <button className="ghost" onClick={() => navigate('chat')}>
            <Icon name="chat" size={14} /> {t('guide.back')}
          </button>
        </div>
      </div>

      <div className="guide-layout">
        <aside className="guide-nav">
          <div className="guide-search">
            <Icon name="search" size={13} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('guide.search')}
              aria-label={t('guide.search')}
            />
            {q && <button className="icon-btn" aria-label={t('guide.clear')} onClick={() => setQ('')}><Icon name="x" size={12} /></button>}
          </div>
          {q.trim().length >= 2 ? (
            <div className="guide-hits">
              {hits.length === 0 && <div className="hint">{t('guide.noHits')}</div>}
              {hits.map((h) => (
                <button
                  key={h.slug + ':' + (h.section || '')}
                  className={`guide-hit ${h.slug === article?.slug ? 'active' : ''}`}
                  onClick={() => { setSlug(h.slug); setQ(''); }}
                >
                  <span className="t">{h.title}</span>
                  {h.section && <span className="s">{h.section}</span>}
                  <span className="sn">{h.snippet}</span>
                </button>
              ))}
            </div>
          ) : (
            <nav className="guide-list">
              {list.map((a) => (
                <button
                  key={a.slug}
                  className={`guide-item ${a.slug === article?.slug ? 'active' : ''}`}
                  onClick={() => setSlug(a.slug)}
                >
                  <span className="t">{a.title}</span>
                  {a.fallback && <span className="guide-fallback" title={t('guide.notTranslated')}>EN</span>}
                </button>
              ))}
            </nav>
          )}
        </aside>

        <main className="guide-content" ref={contentRef}>
          {!article ? (
            <div className="empty-state"><div className="big"><Icon name="book" size={26} /></div><div>{t('guide.empty')}</div></div>
          ) : (
            <>
              <div className="guide-article-head">
                <div>
                  <h2>{article.title}</h2>
                  <div className="hint">{article.summary}</div>
                </div>
                <button className="ghost" onClick={copyLink}><Icon name="copy" size={13} /> {t('guide.copyLink')}</button>
              </div>
              {article.fallback && <div className="guide-note">{t('guide.notTranslated')}</div>}
              <div className="guide-body" ref={bodyRef} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
              <div className="guide-foot">
                <button className="ghost" disabled={!prev} onClick={() => prev && setSlug(prev.slug)}>
                  <Icon name="chevronRight" size={13} style={{ transform: 'rotate(180deg)' }} /> {prev?.title || t('guide.prev')}
                </button>
                <button className="ghost" disabled={!next} onClick={() => next && setSlug(next.slug)}>
                  {next?.title || t('guide.next')} <Icon name="chevronRight" size={13} />
                </button>
              </div>
            </>
          )}
        </main>

        {article && article.headings.length > 1 && (
          <aside className="guide-toc">
            <div className="hint" style={{ marginBottom: 6 }}>{t('guide.onThisPage')}</div>
            {article.headings.map((h) => (
              <button
                key={h.id}
                className="guide-toc-item"
                onClick={() => contentRef.current?.querySelector(`#${CSS.escape(h.id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                {h.text}
              </button>
            ))}
          </aside>
        )}
      </div>
    </div>
  );
}
