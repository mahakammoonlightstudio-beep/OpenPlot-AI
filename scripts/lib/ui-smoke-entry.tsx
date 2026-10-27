/**
 * Server-render smoke entry: renders the app shell and the v1.2 views with
 * react-dom/server. Effects do not run, but component bodies, hooks, imports
 * and initial state do — enough to catch broken imports, bad hook order and
 * render-time crashes without a display server.
 */
import { renderToString } from 'react-dom/server';
import App from '../../src/App';
import { StoryAgentView } from '../../src/components/StoryAgentView';
import { StoryBibleView } from '../../src/components/StoryBibleView';
import { SettingsView } from '../../src/components/SettingsView';
import { ChatView } from '../../src/components/ChatView';
import { Composer } from '../../src/components/Composer';
import { FilePreviewModal } from '../../src/components/FilePreviewModal';
import { ModelSettingsModal } from '../../src/components/ModelSettingsModal';
import { ModelCapabilityCard, ModelProfileRows } from '../../src/components/ModelCapabilityCard';
import { resolveModelProfile } from '../../src/lib/modelCaps';
import { renderMarkdownSync, highlightCacheStats } from '../../src/markdown';
import { GuideView } from '../../src/components/GuideView';
import { ShortcutsSheet } from '../../src/components/ShortcutsSheet';
import { WhatsNewModal } from '../../src/components/WhatsNewModal';
import { useData } from '../../src/store';

export function smoke(): Record<string, string> {
  const out: Record<string, string> = {};
  const render = (name: string, node: any) => {
    try {
      out[name] = renderToString(node);
    } catch (e: any) {
      out[name + 'Error'] = String(e?.stack || e);
    }
  };
  render('app', <App />);
  render('agent', <StoryAgentView />);
  render('story', <StoryBibleView />);
  render('settings', <SettingsView initialSection="data" />);
  // Every Settings section renders on its own: the shell (nav, search, reset)
  // plus one section component. This is what keeps a moved control from
  // silently disappearing behind a nav entry.
  const settingsSections = [
    'providers', 'models', 'behavior', 'styles', 'skills', 'agentmd',
    'appearance', 'memory', 'usage', 'data', 'plugins', 'automations', 'mcp', 'about'
  ];
  for (const s of settingsSections) {
    render('settings-' + s, <SettingsView initialSection={s} />);
    // Advanced mode is where the Extend group and the sampling controls live;
    // rendering both keeps every indexed control covered.
    render('settingsA-' + s, <SettingsView initialSection={s} initialMode="advanced" />);
  }
  render('chat', <ChatView />);
  // Guide: shell + a real article body (tokens rewritten, markdown rendered),
  // plus the two global overlays that read store flags.
  render('guide', <GuideView />);
  for (const slug of ['skills', 'shortcuts', 'troubleshooting']) {
    useData.setState({ guideSlug: slug });
    render('guide-' + slug, <GuideView />);
  }
  useData.setState({ guideSlug: 'getting-started' });
  render('shortcutsSheet', <ShortcutsSheet />);
  render('whatsNew', <WhatsNewModal />);
  // The command palette and a populated automations list read their content
  // from the stores, and zustand's server snapshot is the INITIAL state — a
  // setState in this function would be invisible to `useSyncExternalStore`.
  // Both are therefore covered by the Electron GUI suites; their pure helpers
  // (settings index, prompt bundles) are tested headlessly.
  // The active-chat surfaces (header capabilities, context meter, empty-chat
  // starters, transcript cards) cannot be server-rendered: the chat lives in
  // the DB and messages load in an effect. They are covered by the Electron GUI
  // suites, which drive a real window.
  // Attachment surfaces: populated composer cards + the preview modal (both
  // markdown and plain text paths) render with real props.
  render('composerFiles', (
    <Composer
      input="" setInput={() => {}} onSend={() => {}} streaming={false} onAbort={() => {}}
      effModel="mock-model" effProvider={null} allModels={['mock-model']} onPickModel={() => {}}
      thinkOn={false} setThinkOn={() => {}} thinkSupport="yes" thinkingUi="auto"
      thinkBudget={4096} setThinkBudget={() => {}} maxThinkBudget={50000} toolsOn={false} setToolsOn={() => {}}
      chatProjectId={null} onPickProject={() => {}} onDetachProject={() => {}}
      goal={null} setGoal={() => {}} wordCount={0}
      styles={[]} activeStyleId={null} onPickStyle={() => {}}
      attachments={[{ id: 'a1', name: 'notes.md', kind: 'file', content: '# Hi', bytes: 4 }]}
      onRemoveAttachment={() => {}} onAttachClick={() => {}}
    />
  ));
  const compose = (support: 'yes' | 'no' | 'unknown', ui: 'auto' | 'always', input = '') => (
    <Composer
      input={input} setInput={() => {}} onSend={() => {}} streaming={false} onAbort={() => {}}
      effModel="mock-model" effProvider={null} allModels={['mock-model']} onPickModel={() => {}}
      thinkOn setThinkOn={() => {}} thinkSupport={support} thinkingUi={ui}
      thinkBudget={4096} setThinkBudget={() => {}} maxThinkBudget={50000} toolsOn={false} setToolsOn={() => {}}
      chatProjectId={null} onPickProject={() => {}} onDetachProject={() => {}}
      goal={null} setGoal={() => {}} wordCount={(input.trim().match(/\S+/g) || []).length}
      styles={[]} activeStyleId={null} onPickStyle={() => {}}
      attachments={[]} onRemoveAttachment={() => {}} onAttachClick={() => {}}
    />
  );
  render('composerNoThink', compose('no', 'auto'));
  render('composerUnknownThink', compose('unknown', 'auto'));
  render('composerAlwaysThink', compose('no', 'always'));
  render('composerDraft', compose('yes', 'auto', 'Hello world, this is a draft.'));
  render('modelCapsLine', (
    <ModelSettingsModal
      provider={{ id: 'p1', name: 'Mock', baseUrl: 'http://localhost/v1', apiKey: 'k', enabled: true, models: ['gpt-4o'] } as any}
      model="gpt-4o"
      onClose={() => {}}
      onSave={() => {}}
    />
  ));
  render('filePreviewText', (
    <FilePreviewModal name="draft.txt" kind="file" bytes={11} content={'line one\nline two'} onClose={() => {}} />
  ));
  render('filePreviewMarkdown', (
    <FilePreviewModal name="notes.md" kind="file" bytes={4} content={'# Hi'} onClose={() => {}} />
  ));
  // Highlight cache budget (Task 11): rendering many distinct code blocks must
  // not grow the cache without bound. The stats come from the real module.
  for (let i = 0; i < 400; i++) renderMarkdownSync('```ts\nconst x' + i + ' = ' + i + ';\n```');
  const cache = highlightCacheStats();
  out.__cache = JSON.stringify(cache);

  // Model profile card. First the store-driven card with nothing known yet
  // (every number must read "unknown"), then the read-out alone fed a probed
  // profile plus a real cache observation — SSR cannot see store writes, but
  // the rows component takes the resolved profile directly.
  const cardProvider = {
    id: 'p1', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k',
    enabled: true, models: ['claude-sonnet-4-5', 'claude-3-opus-20240229'], kind: 'anthropic'
  } as any;
  render('modelCapCardUnknown', <ModelCapabilityCard provider={cardProvider} preferredModel="claude-sonnet-4-5" />);
  render('modelProfileKnown', (
    <ModelProfileRows
      profile={resolveModelProfile({
        model: 'claude-sonnet-4-5',
        kind: 'anthropic',
        record: {
          caps: {
            model: 'claude-sonnet-4-5', tools: true, streaming: true, thinking: true,
            contextTokens: 200000, ok: true, probedAt: Date.now()
          },
          cacheObserved: { cachedTokens: 4096, at: Date.now() }
        }
      })}
    />
  ));
  return out;
}
