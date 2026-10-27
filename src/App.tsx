import { lazy, Suspense, useEffect } from 'react';
import { useData, useSettings, useUi, runAutomations, dbCall, createChatUi, clearToastTimers, createProjectUi } from './store';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
// Route-level code splitting (Task 11): Chat and the sidebar are on the startup
// path, everything else loads on first visit. The fallback mirrors the page
// chrome so switching views does not jump the layout.
const StoryBibleView = lazy(() => import('./components/StoryBibleView').then((m) => ({ default: m.StoryBibleView })));
const StoryAgentView = lazy(() => import('./components/StoryAgentView').then((m) => ({ default: m.StoryAgentView })));
const ChaptersView = lazy(() => import('./components/ChaptersView').then((m) => ({ default: m.ChaptersView })));
const FlowView = lazy(() => import('./components/FlowView').then((m) => ({ default: m.FlowView })));
const SettingsView = lazy(() => import('./components/SettingsView').then((m) => ({ default: m.SettingsView })));
const ProjectsView = lazy(() => import('./components/ProjectsView').then((m) => ({ default: m.ProjectsView })));
const StatsView = lazy(() => import('./components/StatsView').then((m) => ({ default: m.StatsView })));
const AboutView = lazy(() => import('./components/AboutView').then((m) => ({ default: m.AboutView })));
const GuideView = lazy(() => import('./components/GuideView').then((m) => ({ default: m.GuideView })));
import { CommandPalette } from './components/CommandPalette';
import { ShortcutsSheet } from './components/ShortcutsSheet';
import { WhatsNewModal } from './components/WhatsNewModal';
import { textPrompt } from './components/TextPrompt';
import { useUnreadStore } from './unreadStore';
import { translate } from './i18n';
import { SHORTCUTS, matchesCombo } from './lib/shortcuts';

/** Open the Prompt Library slash menu on the active chat (no-op elsewhere). */
export function openPromptLibraryUi(): void {
  if (useData.getState().route !== 'chat' || !useData.getState().activeChatId) {
    useUi.getState().toast('Open a chat first to use the Prompt Library', 'info');
    return;
  }
  window.dispatchEvent(new CustomEvent('inkwell:open-prompts'));
}

export default function App() {
  const settings = useSettings();
  // Narrow subscriptions: a toast or a data-store change no longer re-renders
  // the whole shell (which used to reconcile the open view as a side effect).
  const route = useData((s) => s.route);
  const activeChatId = useData((s) => s.activeChatId);
  const sidebarHidden = useUi((s) => s.sidebarHidden);

  // boot: load settings then data
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await useSettings.getState().load();
      if (cancelled) return;
      await useData.getState().load();
      if (cancelled) return;
      // One-shot: the main process upgraded an untouched agent.md to v2.
      // The flag is consumed here so the note never shows twice.
      try {
        if (await dbCall<boolean>('takeAgentMdUpgrade')) {
          useUi.getState().toast(translate(useSettings.getState().lang, 'agentmd.upgraded'), 'info');
        }
      } catch { /* older main process — nothing to consume */ }
      if (cancelled) return;
      runAutomations('app:ready', {});
    })();
    return () => { cancelled = true; };
  }, []);

  // apply theme + accent + language
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
    document.documentElement.style.setProperty('--accent', settings.accent);
    const rgb = hexToRgb(settings.accent);
    document.documentElement.style.setProperty('--accent-soft', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.16)`);
    document.documentElement.lang = settings.lang;
  }, [settings.theme, settings.accent, settings.lang]);

  // Motion preference → one attribute the CSS kill switch reads. `system` asks
  // the OS directly, so a reduced-motion desktop user gets calm animations
  // without touching Settings.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const apply = () => {
      const mode = settings.motion === 'system' ? (mq?.matches ? 'reduced' : 'full') : settings.motion;
      document.documentElement.setAttribute('data-motion', mode);
    };
    apply();
    if (settings.motion !== 'system' || !mq) return;
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, [settings.motion]);

  // Global shortcuts. Only the ones that must work everywhere are handled here;
  // sending/regenerating stay in ChatView, which owns that state. Combos come
  // from the registry so the sheet and the guide cannot drift from this code.
  useEffect(() => {
    const combos = (id: string) => SHORTCUTS.find((s) => s.id === id)?.keys || [];
    // Combos are looked up by id so a rebinding only ever happens in the registry.
    const bindings: Array<[string, () => void]> = [
      ['palette', () => useUi.getState().setPalette(true)],
      ['search', () => window.dispatchEvent(new CustomEvent('inkwell:focus-search'))],
      ['guide', () => useData.getState().navigate('guide')],
      ['shortcuts', () => useUi.getState().setShortcuts(!useUi.getState().shortcutsOpen)],
      ['sidebar', () => useUi.getState().setSidebarHidden(!useUi.getState().sidebarHidden)]
    ];
    const onKey = (e: KeyboardEvent) => {
      for (const [id, fn] of bindings) {
        if (!combos(id).some((c) => matchesCombo(e, c))) continue;
        e.preventDefault();
        fn();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    const openSheet = () => useUi.getState().setShortcuts(true);
    window.addEventListener('inkwell:shortcuts', openSheet);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('inkwell:shortcuts', openSheet);
    };
  }, []);

  // expose palette opener for Sidebar
  useEffect(() => {
    (window as any).__inkwellOpenPalette = () => useUi.getState().setPalette(true);
  }, []);

  // Teardown: cancel pending toast countdowns and scroll-memory writes so a
  // reload/renderer swap leaves no timers running (Task 11).
  useEffect(() => {
    const onUnload = () => clearToastTimers();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      clearToastTimers();
    };
  }, []);

  // Mirror total unread count into the native window title, messenger-style.
  // With nothing unread the active chat's title is shown instead (useful in the
  // taskbar and the window switcher); any other route falls back to the app name.
  useEffect(() => {
    // The data store changes on every streamed token bookkeeping and provider
    // keystroke; only a changed title is worth an IPC round-trip, so compare a
    // cheap signature first instead of calling into main for every write.
    let last = '';
    const apply = () => {
      const total = Object.values(useUnreadStore.getState().unread).reduce((a, b) => a + b, 0);
      const d = useData.getState();
      const active = d.route === 'chat' ? d.chats.find((c) => c.id === d.activeChatId) : null;
      const title = active?.title || '';
      const sig = `${total}|${title}`;
      if (sig === last) return;
      last = sig;
      // Optional chaining: this effect also runs when the renderer is opened
      // in a plain browser (no preload bridge) during development.
      window.inkwell?.setUnreadCount?.(total, title || undefined)?.catch(() => {});
    };
    const un1 = useUnreadStore.subscribe(apply);
    const un2 = useData.subscribe(apply);
    apply();
    return () => { un1(); un2(); };
  }, []);

  // native menu actions (new chat / new project) — handled globally so they
  // work from ANY route (they used to only work while the chat was open)
  useEffect(() => {
    const newChat = async () => {
      await createChatUi('New chat', useData.getState().activeProjectId);
    };
    const openPrompts = () => openPromptLibraryUi();
    const newProject = async () => {
      const name = await textPrompt({ title: 'Project name', confirmLabel: 'Create' });
      if (!name) return;
      await createProjectUi(name);
      useData.getState().navigate('projects');
    };
    const offAction = window.inkwell.onUi('ui:action', (action: string) => {
      if (action === 'new-chat') newChat();
      else if (action === 'new-project') newProject();
      else if (action === 'focus-search') window.dispatchEvent(new CustomEvent('inkwell:focus-search'));
      else if (action === 'open-prompts') openPrompts();
      else if (action === 'guide') useData.getState().navigate('guide');
      else if (action === 'shortcuts') useUi.getState().setShortcuts(true);
    });
    const offToast = window.inkwell.onUi('ui:toast', (msg: string) => {
      if (msg) useUi.getState().toast(msg);
    });
    return () => { offAction(); offToast(); };
  }, []);

  // handle pending prompts coming from Story/Chapters "Ask AI"
  useEffect(() => {
    const handler = () => {
      const prompt = (window as any).__inkwellPendingPrompt;
      if (!prompt) return;
      (window as any).__inkwellPendingPrompt = null;
      (window as any).__inkwellPromptConsumed = null; // fresh handshake per prompt
      // Retry with backoff until ChatView has mounted and loaded its messages
      // (a fixed 350ms timeout used to fire before the chat was ready — the
      // prompt silently vanished). ChatView stamps __inkwellPromptConsumed
      // when it takes the prompt, which stops the retries.
      let attempts = 0;
      const trySend = () => {
        if ((window as any).__inkwellPromptConsumed === prompt) return; // consumed
        attempts++;
        window.dispatchEvent(new CustomEvent('inkwell:send-prompt', { detail: prompt }));
        if (attempts < 8) setTimeout(trySend, attempts * 200);
      };
      setTimeout(trySend, 350);
    };
    window.addEventListener('inkwell:pending-prompt', handler);
    return () => window.removeEventListener('inkwell:pending-prompt', handler);
  }, []);

  // navigate from native menu
  useEffect(() => {
    const off = window.inkwell.onUi('ui:navigate', (routeName: string) => {
      useData.getState().navigate(routeName);
    });
    return off;
  }, []);

/** Skeleton that matches the page chrome, so a lazy route never jumps. */
function RouteFallback() {
  return (
    <div className="page route-skeleton" aria-busy="true">
      <div className="sk-line" style={{ width: 220, height: 18 }} />
      <div className="sk-line" style={{ width: 320, height: 12, marginTop: 10 }} />
      <div className="sk-card" />
    </div>
  );
}

  let body: React.ReactNode;
  switch (route) {
    case 'story': body = <StoryBibleView />; break;
    case 'agent': body = <StoryAgentView />; break;
    case 'chapters': body = <ChaptersView />; break;
    case 'flow': body = <FlowView />; break;
    case 'projects': body = <ProjectsView />; break;
    case 'stats': body = <StatsView />; break;
    case 'settings': body = <SettingsView initialSection="providers" />; break;
    case 'settings-plugins': body = <SettingsView initialSection="plugins" />; break;
    case 'settings-appearance': body = <SettingsView initialSection="appearance" />; break;
    case 'guide': body = <GuideView />; break;
    case 'about': body = <AboutView />; break;
    default: body = <ChatView key={activeChatId || 'none'} />;
  }

  return (
    <div className={`app ${sidebarHidden ? 'sidebar-hidden' : ''}`} id="app-root" tabIndex={-1}>
      <Sidebar />
      <div className="main">
        {/* Lazy routes: the fallback mirrors the page chrome so a first visit to
            Settings, the bible or the guide does not jump the layout. */}
        <Suspense fallback={<RouteFallback />}>{body}</Suspense>
      </div>
      <CommandPalette />
      <ShortcutsSheet />
      <WhatsNewModal />
      <Toasts />
    </div>
  );
}

/** Isolated so toast countdowns only re-render this strip, not the app. */
function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((tst) => (
        <div key={tst.id} className={`toast ${tst.kind}`} onClick={() => dismiss(tst.id)} title="Dismiss">
          {tst.msg}
        </div>
      ))}
    </div>
  );
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const num = parseInt(v, 16);
  if (Number.isNaN(num)) return { r: 124, g: 92, b: 255 };
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
