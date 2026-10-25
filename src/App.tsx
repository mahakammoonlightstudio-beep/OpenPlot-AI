import { useEffect } from 'react';
import { useData, useSettings, useUi, runAutomations, dbCall, createChatUi } from './store';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { StoryBibleView } from './components/StoryBibleView';
import { StoryAgentView } from './components/StoryAgentView';
import { ChaptersView } from './components/ChaptersView';
import { FlowView } from './components/FlowView';
import { SettingsView } from './components/SettingsView';
import { ProjectsView } from './components/ProjectsView';
import { StatsView } from './components/StatsView';
import { AboutView } from './components/AboutView';
import { CommandPalette } from './components/CommandPalette';
import { textPrompt } from './components/TextPrompt';
import { useUnreadStore } from './unreadStore';

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

  // global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useUi.getState().setPalette(true);
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        // Focus the sidebar chat search from anywhere (Electron menu or keyboard)
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('inkwell:focus-search'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // expose palette opener for Sidebar
  useEffect(() => {
    (window as any).__inkwellOpenPalette = () => useUi.getState().setPalette(true);
  }, []);

  // Mirror total unread count into the native window title, messenger-style
  useEffect(() => {
    const unsub = useUnreadStore.subscribe((s) => {
      const total = Object.values(s.unread).reduce((a, b) => a + b, 0);
      // Optional chaining: this effect also runs when the renderer is opened
      // in a plain browser (no preload bridge) during development.
      window.inkwell?.setUnreadCount(total)?.catch(() => {});
    });
    return unsub;
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
      const p = await dbCall<any>('createProject', { name });
      await useData.getState().load();
      useData.getState().setActiveProject(p.id);
      useData.getState().navigate('projects');
    };
    const offAction = window.inkwell.onUi('ui:action', (action: string) => {
      if (action === 'new-chat') newChat();
      else if (action === 'new-project') newProject();
      else if (action === 'focus-search') window.dispatchEvent(new CustomEvent('inkwell:focus-search'));
      else if (action === 'open-prompts') openPrompts();
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
    case 'about': body = <AboutView />; break;
    default: body = <ChatView key={activeChatId || 'none'} />;
  }

  return (
    <div className={`app ${sidebarHidden ? 'sidebar-hidden' : ''}`} id="app-root" tabIndex={-1}>
      <Sidebar />
      <div className="main">{body}</div>
      <CommandPalette />
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
