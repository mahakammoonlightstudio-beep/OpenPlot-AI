import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useData, useSettings, useUi, dbCall, uid, runAutomations, createChatUi, DONATE_URL, SAWERIA_URL, getModelOverride, createProjectUi } from '../store';
import { Chat, Message, Provider, GenerateRequest, GenChunk, MessageFileMeta } from '../types';
import { useMarkdown, useThrottledMarkdown, extractFirstTitle, hardenLinks } from '../markdown';
import { useT } from '../i18nReact';
import { Icon, IconName } from './Icons';
import { useVerifyStore } from '../verifyStore';
import { ModelStatusBar } from './ModelStatusBar';
import { useUnreadStore } from '../unreadStore';
import { Composer } from './Composer';
import { ModelSettingsModal } from './ModelSettingsModal';
import { MenuItem, Modal, Popover } from './Ui';
import { confirmDialog, textPrompt } from './TextPrompt';
import { expandMentions, buildCandidates, MentionCandidate, MentionKind } from '../mentions';
import { useWriteStats } from '../writeStats';
import { FilePreviewModal } from './FilePreviewModal';
import {
  buildAttachmentPrompt, attachmentBytes, formatBytes,
  MAX_CHAT_FILES, MAX_CHAT_FILE_BYTES, MAX_CHAT_TOTAL_BYTES
} from '../lib/chatFiles';
import { inferCacheProfile, replyBudget, resolveThinking, thinkingSupport } from '../lib/modelCaps';
import { describeToolStep } from '../lib/toolProgress';
import type { ToolStep } from '../lib/toolProgress';
import { shortcutById, matchesCombo } from '../lib/shortcuts';
import {
  buildSystemPrompt as composeSystemPrompt, parseSkillsOff, parseSkillsOn,
  parseSkillCommand, matchSkills, ChatMode
} from '../lib/prompt';
import { MessageBubble } from './chat/MessageBubble';
import { StreamingBubble } from './chat/StreamingBubble';
import { WelcomeScreen } from './chat/WelcomeScreen';
import { SaveChapterModal } from './chat/SaveChapterModal';
import {
  clampNum, contentWordCount, estimateTokens, fmtTokens, relativeTime, tokenLabel,
  GUARD_MIN_HISTORY, GUARD_SAFETY_TOKENS,
  buildTranscript
} from '../lib/chatContext';
import type { Attachment } from '../lib/chatContext';

const DEGRADED_MS = 6000;

/** Persisted thinking level (v8). 'auto' keeps following Settings. */
type ThinkLevel = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max';
function isThinkLevel(v: unknown): v is ThinkLevel {
  return v === 'auto' || v === 'off' || v === 'low' || v === 'medium' || v === 'high' || v === 'max';
}
function thinkLevelBudget(level: ThinkLevel): number | null {
  return level === 'low' ? 2048 : level === 'medium' ? 8192 : level === 'high' ? 16384 : level === 'max' ? 32768 : null;
}
function budgetToThinkLevel(n: number): ThinkLevel {
  return n <= 2048 ? 'low' : n <= 8192 ? 'medium' : n <= 16384 ? 'high' : 'max';
}

/** Agent tools that change story-bible rows — the view must refresh itself. */
const STORY_WRITE_TOOLS = new Set([
  'create_project', 'create_story_entry', 'update_story_entry',
  'create_chapter', 'update_chapter', 'append_to_chapter'
]);

// Messages above the visible window render as cheap skeletons until the user
// scrolls up — keeps long chats fast without breaking autoscroll anchoring.
const RENDER_WINDOW = 60;
/** Rows loaded from the DB per page. Memory stays bounded; readers page back. */
const MESSAGE_PAGE = 200;

// A draft handed to the NEXT ChatView instance. App mounts the view with
// `key={activeChatId}`, so creating a chat remounts it — calling setInput right
// after createChatUi() writes to the unmounted instance and the prompt the
// welcome card inserted disappears. The new instance takes it on mount.
let pendingChatDraft: string | null = null;

/**
 * Memoized so a streaming reply (which re-renders ChatView on every frame)
 * does not reconcile every message bubble in the transcript. The callbacks
 * passed from ChatView are stable (they read the latest logic from a ref), so
 * only the message whose data actually changed re-renders.
 */
export function ChatView() {
  const t = useT();
  const settings = useSettings();
  // Field-level selectors: ChatView used to subscribe to the WHOLE data store,
  // so adding a story entry or chapter re-rendered the entire transcript.
  const chats = useData((s) => s.chats);
  const projects = useData((s) => s.projects);
  const providers = useData((s) => s.providers);
  const styles = useData((s) => s.styles);
  const allChapters = useData((s) => s.chapters);
  const allStory = useData((s) => s.story);
  const activeChatId = useData((s) => s.activeChatId);
  const activeProjectId = useData((s) => s.activeProjectId);
  const route = useData((s) => s.route);
  const navigate = useData((s) => s.navigate);
  const setActiveChat = useData((s) => s.setActiveChat);
  const setActiveProject = useData((s) => s.setActiveProject);
  const reloadChatRelated = useData((s) => s.reloadChatRelated);
  const ui = useUi();

  const chat = chats.find((c) => c.id === activeChatId) || null;
  const [messages, setMessages] = useState<Message[]>([]);
  // Paging state (Task 11): the view holds the newest MESSAGE_PAGE rows plus
  // whatever the reader pulled in, and never the whole 5,000-message chat.
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // ---- reply variants (v1.2.5) ------------------------------------------
  // Assistant rows that answer the same user turn are variants of that turn.
  // Resend/regenerate no longer deletes the previous answer, so the bubble can
  // flip through them with "‹ 1/2 ›" instead of losing it forever.
  const [variantPick, setVariantPick] = useState<Record<string, string>>({});
  // Prompt versions are a SEPARATE axis from reply restarts: editing your own
  // message forks a version instead of overwriting it.
  const [userPick, setUserPick] = useState<Record<string, string>>({});
  // The user turn whose replacement is streaming in right now (null = none).
  // Its previous answer is hidden while it streams so the fresh reply appears
  // IN PLACE instead of as a second bubble under the old one.
  const [streamingTurn, setStreamingTurn] = useState<string | null>(null);
  useEffect(() => { setVariantPick({}); setUserPick({}); }, [activeChatId]);
  // Two INDEPENDENT histories: the arrows on YOUR message walk the edits of
  // that prompt, the arrows on a REPLY walk the restarts of that answer.
  const tx = useMemo(
    () => buildTranscript(messages, userPick, variantPick, streamingTurn),
    [messages, userPick, variantPick, streamingTurn]
  );
  const visibleMessages = tx.visible;
  const pickVariant = useCallback((parentId: string, id: string) => {
    setVariantPick((cur) => ({ ...cur, [parentId]: id }));
  }, []);
  const pickUserVersion = useCallback((slot: string, id: string) => {
    setUserPick((cur) => ({ ...cur, [slot]: id }));
  }, []);
  // Read without consuming: StrictMode double-invokes initializers in dev, so a
  // take-and-clear here would hand the second call an empty draft.
  const [input, setInput] = useState(pendingChatDraft ?? '');
  useEffect(() => { pendingChatDraft = null; }, []);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamThink, setStreamThink] = useState('');
  const [streamTools, setStreamTools] = useState<string[]>([]);
  // Readable progress rows for the running agent (project → entries → chapters).
  const [streamSteps, setStreamSteps] = useState<ToolStep[]>([]);
  // PERF: re-parse the streaming bubble at most once per frame (was per token).
  const streamHtml = useThrottledMarkdown(streamText, streaming);
  const reqIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const activeChatIdRef = useRef<string | null>(activeChatId);
  activeChatIdRef.current = activeChatId;

  // Floating scroll navigation state
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const [headerHidden, setHeaderHidden] = useState(false);
  const [headerScrolled, setHeaderScrolled] = useState(false);
  const lastScrollTopRef = useRef(0);
  // Per-chat scroll memory: chatId -> scrollTop
  const scrollPosRef = useRef<Map<string, number>>(new Map());
  const pendingRestoreRef = useRef<string | null>(null);

  // Zen mode: dim the chat chrome for distraction-free reading; the sidebar
  // can also be slid away (state lives in useUi so App can class the shell).
  const [zen, setZen] = useState(false);
  useEffect(() => { if (!zen && !ui.sidebarHidden) return; const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setZen(false); ui.setSidebarHidden(false); } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [zen, ui.sidebarHidden]);

  // Progressive message rendering: only the newest RENDER_WINDOW messages get
  // full markdown; older ones collapse to skeletons until scrolled into view.
  // Expand decisions persist per chat across restarts (localStorage).
  const [renderLimit, setRenderLimit] = useState(RENDER_WINDOW);
  useEffect(() => {
    if (!activeChatId) return;
    try {
      const raw = localStorage.getItem('openplot.renderLimit.v1');
      const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
      const saved = map[activeChatId];
      setRenderLimit(typeof saved === 'number' && saved >= RENDER_WINDOW ? saved : RENDER_WINDOW);
    } catch { setRenderLimit(RENDER_WINDOW); }
  }, [activeChatId]);

  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /**
   * Pull one older page from the database and prepend it without moving the
   * reader: the height added above the viewport is subtracted from scrollTop.
   */
  const loadOlder = useCallback(async () => {
    const el = scrollRef.current;
    if (!el || !activeChatIdRef.current || loadingOlder) return;
    const firstRow = messages[0] as (Message & { _row?: number }) | undefined;
    const before = firstRow?.created_at;
    if (before == null) return;
    setLoadingOlder(true);
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    try {
      const page = await dbCall<{ rows: Message[]; hasMore: boolean }>('getMessagePage', {
        chatId: activeChatIdRef.current, limit: MESSAGE_PAGE, before, beforeRow: firstRow?._row
      });
      const rows = Array.isArray(page) ? page : (page?.rows || []);
      setHasOlder(Array.isArray(page) ? false : !!page?.hasMore);
      if (rows.length) {
        setMessages((m) => [...rows, ...m]);
        // Compensate after React commits the new nodes.
        requestAnimationFrame(() => {
          const after = scrollRef.current;
          if (after) after.scrollTop = prevTop + (after.scrollHeight - prevHeight);
        });
      }
    } catch { /* chat deleted mid-load — keep what is on screen */ }
    setLoadingOlder(false);
  }, [loadingOlder, messages, activeChatIdRef]);

  function expandEarlier() {
    if (loadingEarlier) return;
    setLoadingEarlier(true);
    // Give the browser one painted frame of skeletons before the heavy render
    requestAnimationFrame(() => setTimeout(() => {
      setRenderLimit((n) => {
        const next = n + RENDER_WINDOW;
        try {
          const raw = localStorage.getItem('openplot.renderLimit.v1');
          const map = raw ? JSON.parse(raw) : {};
          if (activeChatId) {
            map[activeChatId] = next;
            // Cap the map: fifty chats is far more history than a session needs
            // and the list used to grow with every chat ever opened.
            const ids = Object.keys(map);
            if (ids.length > 50) for (const old of ids.slice(0, ids.length - 50)) delete map[old];
            localStorage.setItem('openplot.renderLimit.v1', JSON.stringify(map));
          }
        } catch { /* storage full — expansion still works this session */ }
        return next;
      });
      setLoadingEarlier(false);
    }, 160));
  }

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [modelModal, setModelModal] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const enabledProviders = providers.filter((p) => p.enabled);

  // Transcript attachment preview: only metadata travels with getMessages, so
  // the body is fetched on demand. A deleted message/file shows the error
  // instead of a blank modal.
  const [filePreview, setFilePreview] = useState<{
    id: string; name: string; kind: MessageFileMeta['kind']; bytes: number;
    content: string | null; loading: boolean; error?: string;
  } | null>(null);
  const openMessageFile = useCallback(async (f: MessageFileMeta) => {
    setFilePreview({ id: f.id, name: f.name, kind: f.kind, bytes: f.bytes, content: null, loading: true });
    try {
      const row = await dbCall<{ content: string }>('readMessageFile', { id: f.id });
      setFilePreview((cur) => (cur && cur.id === f.id ? { ...cur, content: row.content, loading: false } : cur));
    } catch (e: any) {
      setFilePreview((cur) => (cur && cur.id === f.id ? { ...cur, loading: false, error: e?.message || String(e) } : cur));
    }
  }, []);

  // Unread state: new background replies show a jump pill
  const unreadCount = useUnreadStore((s) => (activeChatId ? (s.unread[activeChatId] || 0) : 0));

  // per-chat advanced overrides
  const [ovModel, setOvModel] = useState<string | null>(null);
  const [ovSystem, setOvSystem] = useState<string | null>(null);
  const [ovTemp, setOvTemp] = useState<number | null>(null);
  const [ovMaxTok, setOvMaxTok] = useState<number | null>(null);
  const [ovTopP, setOvTopP] = useState<number | null>(null);
  const [thinkOn, setThinkOn] = useState<boolean | null>(null);
  const [thinkBudget, setThinkBudget] = useState<number | null>(null);
  // Local mirror so the picker reacts instantly; the chat row is the truth.
  const [thinkLevel, setThinkLevel] = useState<ThinkLevel | null>(null);
  const [toolsOn, setToolsOn] = useState<boolean | null>(null);
  const [memOn, setMemOn] = useState<boolean | null>(null);
  // Session goal pinned from the composer ADD panel — injected into every
  // system prompt until cleared (null = no goal).
  const [goal, setGoal] = useState<string | null>(null);
  useEffect(() => { setGoal(null); }, [activeChatId]);
  // Working mode + agent mode are per-chat rows. Local state makes the switch
  // instant; the row is the source of truth on the next load.
  const [agentMode, setAgentMode] = useState<boolean | null>(null);
  const [chatMode, setChatMode] = useState<ChatMode | null>(null);
  // Web research without agent mode: the same web_search / web_fetch tools,
  // offered as one switch, per chat (session-scoped — the chat row is full).
  const [webSearchOn, setWebSearchOn] = useState(false);
  const chatAgentOn = agentMode ?? (Number((chat as any)?.agent_mode) === 1);
  const chatModeOn: ChatMode = chatMode ?? (((chat as any)?.chat_mode as ChatMode) || 'write');
  const chatSkillsOn = parseSkillsOn((chat as any)?.skills_on);

  // ---- attachments: files & story content as chips (never inline text) ----
  // OS files keep their whole content; story bible entries and chapters can
  // be dragged straight from their views. At send time they ride in the
  // system prompt as fenced blocks and the composer text stays clean.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Mirror for the cap math: reading `attachments` inside addAttachments would
  // use the value captured at render time, and two drops in one frame could
  // then both pass the 1 MB check.
  const attachmentsRef = useRef<Attachment[]>([]);
  attachmentsRef.current = attachments;
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    attachmentsRef.current = [];
    setAttachments([]);
    setDragOver(false);
  }, [activeChatId]);

  function addAttachments(next: Attachment[]) {
    const cur = attachmentsRef.current;
    const room = Math.max(0, MAX_CHAT_FILES - cur.length);
    if (next.length > room) ui.toast(t('chat.attachLimit'), 'error');
    let total = cur.reduce((n, a) => n + attachmentBytes(a), 0);
    const kept: Attachment[] = [];
    for (const a of next.slice(0, room)) {
      const bytes = attachmentBytes(a);
      if (bytes > MAX_CHAT_FILE_BYTES) {
        ui.toast(t('chat.fileTooBig')
          .replace('{name}', a.name)
          .replace('{max}', String(MAX_CHAT_FILE_BYTES / 1024)), 'error');
        continue;
      }
      if (total + bytes > MAX_CHAT_TOTAL_BYTES) {
        ui.toast(t('chat.filesTotalTooBig'), 'error');
        break;
      }
      total += bytes;
      kept.push({ ...a, bytes });
    }
    if (!kept.length) return;
    const merged = [...cur, ...kept];
    attachmentsRef.current = merged;
    setAttachments(merged);
  }
  function removeAttachment(id: string) { setAttachments((a) => a.filter((x) => x.id !== id)); }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const dt = e.dataTransfer;
    const next: Attachment[] = [];
    // 1) story bible entries / chapters dragged from inside the app
    try {
      const storyRaw = dt.getData('application/x-openplot-story');
      if (storyRaw) {
        const { id } = JSON.parse(storyRaw);
        const entry = useData.getState().story.find((s) => s.id === id);
        if (entry) next.push({ id: uid(), name: `${entry.title} (story)`, kind: 'story', content: entry.content });
      }
      const chapterRaw = dt.getData('application/x-openplot-chapter');
      if (chapterRaw) {
        const { id } = JSON.parse(chapterRaw);
        const ch = useData.getState().chapters.find((c) => c.id === id);
        if (ch) next.push({ id: uid(), name: `${ch.title} (chapter)`, kind: 'chapter', content: ch.content });
      }
    } catch { /* malformed drag payload — ignore */ }
    // 2) OS files (path via preload webUtils; fallback to in-memory read)
    for (const f of Array.from(dt.files || []).slice(0, 8)) {
      try {
        const path = window.inkwell.pathForFile?.(f) || '';
        if (path) {
          // Reading is grant-based: the dropped File itself is what registers
          // the path, so a synthetic path cannot be granted by name.
          await window.inkwell.grantDroppedFiles([f]);
          const rows = await window.inkwell.readFiles([path]);
          if (rows.length) next.push({ id: uid(), name: rows[0].name, kind: 'file', content: rows[0].content });
        } else if (f.size < 300_000) {
          next.push({ id: uid(), name: f.name, kind: 'file', content: await f.text() });
        }
      } catch { /* unreadable — skip */ }
    }
    if (next.length) addAttachments(next);
  }

  useEffect(() => {
    let cancelled = false;
    if (!chat) { setMessages([]); return; }
    setOvModel(chat.model ?? null);
    setOvSystem(chat.system_prompt ?? null);
    // reset overrides that aren't persisted per chat
    setOvTemp(null); setOvMaxTok(null); setOvTopP(null);
    setThinkOn(null); setThinkBudget(null); setThinkLevel(null); setToolsOn(null); setMemOn(null);
    setAgentMode(null); setChatMode(null); setWebSearchOn(false);
    setHasOlder(false);
    dbCall<{ rows: Message[]; hasMore: boolean }>('getMessagePage', { chatId: chat.id, limit: MESSAGE_PAGE }).then((page) => {
      if (cancelled) return;
      // Defensive: an older main process (or a stubbed bridge in tests) can
      // still answer with a plain array — accept both shapes.
      if (Array.isArray(page)) { setMessages(page); return; }
      setMessages(page?.rows || []);
      setHasOlder(!!page?.hasMore);
    }).catch(() => { /* chat deleted mid-load */ });
    useUnreadStore.getState().markRead(chat.id);
    setRenderLimit(RENDER_WINDOW);
    return () => { cancelled = true; };
  }, [activeChatId]);

  // Autoscroll only when the user is already near the bottom.
  // Also: remembers scroll position per chat and auto-hides the header
  // while scrolling down through long conversations.
  const updateScrollNav = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const st = el.scrollTop;
    const distance = el.scrollHeight - st - el.clientHeight;
    stickToBottomRef.current = distance < 80;
    setCanScrollUp(st > 8);
    setCanScrollDown(distance > 8);
    setHeaderScrolled(st > 4);

    const chatId = activeChatIdRef.current;
    if (chatId) {
      const pos = scrollPosRef.current;
      // Keep the map bounded: scroll positions of long-closed chats are dead
      // weight, and the reader only ever returns to a handful (Task 11).
      if (pos.has(chatId)) pos.delete(chatId);
      pos.set(chatId, st);
      while (pos.size > 50) pos.delete(pos.keys().next().value as string);
    }

    // Auto-hide: scrolling down well past the top hides the header;
    // any upward scroll or near-top position brings it back.
    const prev = lastScrollTopRef.current;
    if (st > prev + 4 && distance > 180 && st > 120) setHeaderHidden(true);
    else if (st < prev - 4 || st < 60) setHeaderHidden(false);
    lastScrollTopRef.current = st;
  }, []);

  const onMessagesScroll = updateScrollNav;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // First render after a chat switch: restore the saved scroll position
    // (or jump to the latest message if none was saved).
    const chatId = activeChatIdRef.current;
    if (pendingRestoreRef.current && chatId && pendingRestoreRef.current === chatId && messages.length) {
      pendingRestoreRef.current = null;
      const saved = scrollPosRef.current.get(chatId);
      const max = el.scrollHeight - el.clientHeight;
      if (saved != null && saved <= max + 4) {
        el.scrollTop = saved;
        stickToBottomRef.current = max - saved < 80;
      } else {
        el.scrollTop = max;
        stickToBottomRef.current = true;
      }
      updateScrollNav();
      return;
    }
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    updateScrollNav();
  }, [messages.length, streamText, streamThink, streaming, updateScrollNav]);

  useEffect(() => {
    // Chat switched: restore position on next message render, show header
    pendingRestoreRef.current = activeChatId;
    setHeaderHidden(false);
    lastScrollTopRef.current = 0;
  }, [activeChatId]);

  function scrollByAmount(dir: 'up' | 'down') {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ top: dir === 'up' ? -el.clientHeight * 0.8 : el.clientHeight * 0.8, behavior: 'smooth' });
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  const newChat = useCallback(async () => {
    await createChatUi('New chat', useData.getState().activeProjectId);
  }, []);

  // Creating from the welcome screen goes through the central helper so the
  // `chat:new` automation fires exactly once with identical side effects.
  async function ensureChat(): Promise<Chat> {
    if (chat) return chat;
    const c = await createChatUi('New chat', activeProjectId);
    return c as Chat;
  }

  // MCP tools of currently connected servers. Refreshed when the tools toggle
  // flips and when the chat changes; failures leave an empty list, which simply
  // omits the block from the prompt.
  const [mcpToolNames, setMcpToolNames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!(chatAgentOn || (toolsOn ?? settings.toolsEnabled))) { setMcpToolNames([]); return; }
    (async () => {
      try {
        const statuses = (await window.inkwell.mcpList())?.data || [];
        const names = statuses
          .filter((s) => s.status === 'connected')
          .flatMap((s) => s.toolNames || []);
        if (!cancelled) setMcpToolNames(names);
      } catch { if (!cancelled) setMcpToolNames([]); }
    })();
    return () => { cancelled = true; };
  }, [toolsOn, settings.toolsEnabled, chatAgentOn, activeChatId]);

  // `runSkill` automation action: the chosen skill rides into the next send as
  // the session goal, so the user can see (and edit) what was injected.
  useEffect(() => {
    const onApplySkill = (e: Event) => {
      const id = (e as CustomEvent).detail as string;
      const skill = useData.getState().skills.find((s) => s.id === id);
      if (!skill) return;
      setGoal(`${skill.name}\n${skill.content}`);
    };
    window.addEventListener('inkwell:apply-skill', onApplySkill);
    return () => window.removeEventListener('inkwell:apply-skill', onApplySkill);
  }, []);

  const effModel = ovModel ?? settings.defaultModel ?? null;
  // Resolve the provider that OWNS the selected model — never fall back to a
  // random enabled provider, or the request 404s against the wrong endpoint.
  const effProvider: Provider | null =
    enabledProviders.find((p) => (Array.isArray(p.models) ? p.models : []).includes(effModel || '')) || null;
  // Per-model tuning from the Edit-model modal (context/maxTokens/temp/topP/budget).
  const modelOv = getModelOverride(settings.modelOverrides, effProvider?.id, effModel);

  // ---- thinking capability (Task 4) -------------------------------------
  // Evidence comes from the persisted registry (rejected / probed) and falls
  // back to the model-family table. `unknown` is a real answer: the control is
  // shown muted rather than pretending the model can or cannot think.
  const thinkCapsKey = effProvider && effModel ? `${effProvider.id}::${effModel}` : '';
  const capsRecord = thinkCapsKey ? settings.modelCaps[thinkCapsKey] : undefined;
  const thinkSupport = thinkingSupport(effModel || '', {
    kind: (effProvider as any)?.kind || 'auto',
    record: capsRecord
  });
  const contextForThinking = modelOv?.context ?? capsRecord?.caps?.contextTokens ?? 0;
  const maxThinkBudget = contextForThinking > 2048 ? Math.max(1024, Math.floor(contextForThinking / 2)) : 100000;
  // A stored level wins over the session overrides; 'auto' keeps the old
  // settings-driven behaviour for chats that never picked one.
  const storedThinkLevel: ThinkLevel = isThinkLevel((chat as any)?.think_level) ? ((chat as any).think_level as ThinkLevel) : 'auto';
  const activeThinkLevel: ThinkLevel = thinkLevel ?? storedThinkLevel;
  const effThinkOn = activeThinkLevel === 'auto' ? (thinkOn ?? settings.thinkingEnabled) : activeThinkLevel !== 'off';
  const effThinkBudget = thinkLevelBudget(activeThinkLevel) ?? thinkBudget ?? modelOv?.thinkBudget ?? settings.thinkingBudget;
  const thinkResolved = resolveThinking(
    thinkSupport,
    effThinkOn,
    effThinkBudget,
    contextForThinking
  );
  // Session-only reasoning durations. There is no DB column for them: after a
  // restart the trace still opens, it just shows the plain header.
  const thinkDurationsRef = useRef<Record<string, number>>({});

  /**
   * Prompt assembly lives in `src/lib/prompt.ts` so it can be tested without a
   * window. This wrapper only gathers what the store already has.
   */
  /**
   * Canon rows for the prompt. Agent mode reads the bible through tools, so
   * this is only used when the agent loop is off — a bound project still gives
   * the model its characters, places and lore without any tool call.
   */
  function bibleEntries(chatRow: Chat, state: ReturnType<typeof useData.getState>) {
    if (chatAgentOn) return [];
    const projectId = chatRow.project_id || activeProjectId;
    if (!projectId) return [];
    return state.story
      .filter((e) => !e.project_id || e.project_id === projectId)
      .map((e) => ({ title: e.title, category: e.kind, content: e.content }));
  }

  function buildSystemPrompt(
    chatRow: Chat,
    promptAttachments: Array<{ name: string; kind: 'file' | 'story' | 'chapter'; content: string }> = attachments
  ): string {
    const state = useData.getState();
    const project = projects.find((p) => p.id === (chatRow.project_id || activeProjectId)) || null;
    return composeSystemPrompt({
      systemOverride: ovSystem,
      defaultSystem: settings.defaultSystem,
      agentMd: settings.agentMd,
      project,
      memories: state.memories.map((m) => m.content),
      memoryEnabled: memOn ?? settings.memoryEnabled,
      skills: state.skills,
      skillsOff: parseSkillsOff(chatRow.skills_off),
      skillsOn: parseSkillsOn(chatRow.skills_on),
      mode: chatModeOn,
      agentMode: chatAgentOn,
      style: state.styles.find((s) => s.id === settings.defaultStyleId) || null,
      goal,
      toolsEnabled: chatAgentOn || webSearchOn || (toolsOn ?? settings.toolsEnabled),
      webSearch: webSearchOn && !chatAgentOn,
      // Canon without agent mode: a bound project's bible rides along so the AI
      // can answer about characters that were never attached by hand.
      bible: bibleEntries(chatRow, state),
      // Only connected MCP servers are named, so the model is never told about
      // a tool it cannot call (Task 13).
      mcpTools: mcpToolNames,
      attachments: promptAttachments
    });
  }

  async function send(pendingUser?: Message, textOverride?: string, historyBase?: Message[]) {
    if (streaming) return;
    const text = (textOverride ?? input).trim();
    // Attachments alone (no typed text) are a valid send.
    if (!pendingUser && !text && !attachments.length) return;

    // "/skill/<name>" and "/skill/all" are composer commands, never chat text:
    // they switch skills on for this chat and nothing is sent to the model.
    if (!pendingUser) {
      const cmd = parseSkillCommand(text);
      if (cmd) { await runSkillCommand(cmd); return; }
    }

    if (!enabledProviders.length) { ui.toast(t('chat.noProvider'), 'error'); return; }
    if (!effModel || !effProvider) { ui.toast(t('chat.noModel'), 'error'); return; }
    // The selected model must actually belong to a provider — otherwise the
    // request silently goes to the first enabled provider and 404s there.
    const modelProvider =
      enabledProviders.find((p) => (Array.isArray(p.models) ? p.models : []).includes(effModel)) || null;
    if (!modelProvider) {
      ui.toast(`${effModel}: ${t('chat.modelNotOnProvider')}`, 'error');
      return;
    }
    if (!effProvider.baseUrl || !String(effProvider.baseUrl).trim()) {
      ui.toast(t('chat.baseUrlMissing').replace('{name}', effProvider.name), 'error');
      return;
    }

    const chatRow = await ensureChat();
    const chatId = chatRow.id;

    let userMsg = pendingUser;
    let firstFileName = '';
    if (!userMsg) {
      // One call writes the user turn AND its files — a rejection (too large,
      // binary, too many) leaves no partial row and keeps the composer intact.
      const filesSent = attachments.map((a) => ({ name: a.name, kind: a.kind, content: a.content }));
      firstFileName = filesSent[0]?.name || '';
      try {
        userMsg = await dbCall<Message>('addMessage', { chatId, role: 'user', content: text, files: filesSent });
      } catch (e: any) {
        ui.toast(e?.message || String(e), 'error');
        return;
      }
      setMessages((m) => [...m, userMsg!]);
      setInput('');
      // Attachments rode along with this send — the next message starts clean.
      attachmentsRef.current = [];
      setAttachments([]);
    }
    // `chat:send` fires once per send, after the user turn is safely stored.
    runAutomations('chat:send', { chatId, chars: text.length });

    // auto title from first user message (or the first attached file name)
    if (chatRow.title === 'New chat' && userMsg) {
      const auto = userMsg.content.slice(0, 40).trim() || firstFileName.slice(0, 40).trim() || 'New chat';
      await dbCall('updateChat', { id: chatId, title: auto });
      reloadChatRelated();
    }

    // Build history: when regenerating/resending, `pendingUser` is already in
    // `messages` — dedupe by id so it isn't sent twice. `historyBase` lets
    // callers pass a trimmed snapshot: the state closure still contains rows
    // that were just deleted (old assistant reply on regen), which must not
    // leak into the model's context.
    const base = historyBase ?? visibleMessages;
    // Hidden variant replies must never reach the model: the regenerated turn
    // is sent as if its siblings did not exist.
    const prior = pendingUser
      ? base.filter((m) => m.id !== pendingUser.id && m.parent_id !== pendingUser.id)
      : base;
    const history: Message[] = [...prior, userMsg];

    // Resend/regenerate sends an existing user row, whose file bodies are not
    // in message state (metadata only) — load them so the model keeps seeing
    // the attachment instead of silently losing the context.
    let promptAttachments: Array<{ name: string; kind: 'file' | 'story' | 'chapter'; content: string }> = [];
    if (pendingUser?.files?.length) {
      const loaded = await Promise.all(pendingUser.files.map(async (f) => {
        try {
          const row = await dbCall<{ content: string }>('readMessageFile', { id: f.id });
          return { name: f.name, kind: f.kind, content: row.content };
        } catch { return null; }
      }));
      promptAttachments = loaded.filter((f): f is { name: string; kind: 'file' | 'story' | 'chapter'; content: string } => !!f);
    } else if (!pendingUser) {
      promptAttachments = attachments;
    }
    const sys = buildSystemPrompt(chatRow, promptAttachments);
    // @-mentions: expand tokens into full content blocks FOR THE MODEL ONLY —
    // the stored transcript keeps the compact token so edit/resend still works.
    const mentionCands = buildCandidates(
      useData.getState().story,
      useData.getState().chapters,
      chatRow.project_id || activeProjectId
    );
    const resolveMention = (kind: MentionKind, title: string): MentionCandidate | null =>
      mentionCands.find((c) => c.kind === kind && c.title.toLowerCase() === title.toLowerCase()) || null;
    const historyExpanded = await Promise.all(
      history.map(async (m) => ({
        role: m.role,
        content: m.role === 'user' ? await expandMentions(m.content, resolveMention) : m.content
      }))
    );
    let payloadMessages: GenerateRequest['messages'] = [
      { role: 'system', content: sys },
      ...historyExpanded
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .filter((m) => m.content && m.content.trim())
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    ];

    // Context guard: a known window (per-model override) turns silent
    // provider 400s into a graceful "oldest turns trimmed" behavior.
    const contextWindow = modelOv?.context ?? 0;
    if (contextWindow > 0) {
      const maxOut = replyBudget(ovMaxTok ?? modelOv?.maxTokens ?? settings.maxTokens, effModel || '');
      const budget = contextWindow - maxOut - GUARD_SAFETY_TOKENS;
      if (budget > 0) {
        const total = payloadMessages.reduce((a, m) => a + estimateTokens(m.content), 0);
        if (total > budget) {
          const sysTok = estimateTokens(payloadMessages[0]?.content || '');
          const kept: typeof payloadMessages = [];
          let used = sysTok;
          for (let i = payloadMessages.length - 1; i >= 1; i--) {
            const tk = estimateTokens(payloadMessages[i].content);
            if (kept.length >= GUARD_MIN_HISTORY && used + tk > budget) break;
            kept.unshift(payloadMessages[i]);
            used += tk;
          }
          const dropped = payloadMessages.length - 1 - kept.length;
          if (dropped > 0) {
            payloadMessages = [payloadMessages[0], ...kept];
            setContextTrimmed((c) => (c === null ? dropped : c + dropped));
          }
        }
      }
    }

    const provider = modelProvider;
    const req: GenerateRequest = {
      reqId: uid(),
      chatId,
      // The main process resolves the stored base URL and key by id.
      provider: {
        id: provider.id, name: provider.name, baseUrl: provider.baseUrl,
        enabled: true, models: provider.models as string[], kind: (provider as any).kind
      },
      model: effModel,
      messages: payloadMessages,
      temperature: ovTemp ?? modelOv?.temperature ?? settings.temperature,
      // 0 = "model's own ceiling" — see `replyBudget`. A fixed 4k default used to
      // truncate long scenes even on models that can emit 64k.
      maxTokens: replyBudget(ovMaxTok ?? modelOv?.maxTokens ?? settings.maxTokens, effModel || ''),
      topP: ovTopP ?? modelOv?.topP ?? settings.topP,
      // A model that cannot expose reasoning never receives the parameter, no
      // matter what the global preference says; the budget obeys the context
      // window so "thinking" cannot starve the actual answer.
      thinkingEnabled: thinkResolved.enabled,
      thinkingBudget: thinkResolved.budget,
      toolsEnabled: chatAgentOn || webSearchOn || (toolsOn ?? settings.toolsEnabled),
      projectId: chatRow.project_id || activeProjectId || null
    };

    reqIdRef.current = req.reqId;
    setStreaming(true);
    setStreamingTurn(userMsg.id);
    setStreamText('');
    setStreamThink('');
    setStreamTools([]); setStreamSteps([]);
    stickToBottomRef.current = true;

    let accText = '';
    let accThink = '';
    let thinkFirstAt = 0;
    let thinkLastAt = 0;
    const accTools: string[] = [];
    // The same rows the live panel shows are the ones saved with the reply, so
    // reopening the chat tells the same story instead of just listing names.
    const accSteps: ToolStep[] = [];
    // Coalesce chunk bursts into one render per animation frame — tokens can
    // arrive faster than 60fps and each setState used to mean a full re-render.
    let rafPending = false;
    let dirtyText = '';
    let dirtyThink = '';
    const flushStreamFrame = () => {
      rafPending = false;
      setStreamText(dirtyText);
      setStreamThink(dirtyThink);
    };
    // Agent writes happen in the main process, so the renderer store went
    // stale until the whole app was reloaded (users had to "reset" to see a
    // profile the AI just created). Refresh just the Story Bible rows when a
    // write tool returns — silent, debounced, no navigation.
    let storyReloadTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleStoryReload = () => {
      if (storyReloadTimer) clearTimeout(storyReloadTimer);
      storyReloadTimer = setTimeout(() => {
        storyReloadTimer = null;
        useData.getState().reloadStory();
      }, 250);
    };
    const off = window.inkwell.onAiChunk(({ reqId, chunk }) => {
      if (reqId !== req.reqId) return;
      const c = chunk as GenChunk;
      if (c.type === 'text') { accText += c.text || ''; dirtyText = accText; }
      else if (c.type === 'thinking') {
        accThink += c.text || '';
        dirtyThink = accThink;
        // Reasoning duration = first → last reasoning chunk, so the time spent
        // writing the answer afterwards is not counted as "thought for".
        if (!thinkFirstAt) thinkFirstAt = Date.now();
        thinkLastAt = Date.now();
      }
      else if (c.type === 'replaceText') { accText = c.text || ''; dirtyText = accText; }
      else if (c.type === 'tool' && c.tool) {
        accTools.push(c.tool.name);
        const step = describeToolStep(c.tool!.name, c.tool!.result);
        accSteps.push(step);
        setStreamTools((a) => [...a, c.tool!.name]);
        setStreamSteps((a) => [...a, step]);
        if (STORY_WRITE_TOOLS.has(c.tool.name)) scheduleStoryReload();
      }
      if (!rafPending) { rafPending = true; requestAnimationFrame(flushStreamFrame); }
    });

    const startedAt = Date.now();
    let res: Awaited<ReturnType<typeof window.inkwell.generate>>;
    try {
      res = await window.inkwell.generate(req);
    } finally {
      if (rafPending) { cancelAnimationFrame(rafPending); rafPending = false; }
      off();
    }

    const aborted = !!(res.ok && (res.data as any)?.aborted);
    const userAborted = aborted || (res.ok === false && !res.error);
    const thinkMs = thinkFirstAt && thinkLastAt ? Math.max(0, thinkLastAt - thinkFirstAt) : 0;

    // Real evidence beats the family table: the provider either rejected the
    // thinking parameter (main retried without it) or failed with a thinking
    // error. Persist it so the next chat hides the control immediately.
    const thinkingRefused = res.ok
      ? !!res.data?.thinkingRejected
      : (!userAborted && thinkResolved.enabled && /thinking|reasoning|budget/i.test(String(res.error || '')));
    if (thinkingRefused && thinkCapsKey) {
      // Merge in the main process (it owns the registry) and refresh the store
      // so the composer hides the control on the next render. Fire-and-forget:
      // a failed write must never block the reply.
      void window.inkwell.markThinkingRejected(provider.id, effModel || '')
        .then((r) => (r?.ok ? useSettings.getState().load() : undefined))
        .catch(() => {});
    }

    // Auto health tracking: feed the model status bar from real usage.
    // Deliberate user aborts are excluded — they say nothing about model health.
    if (!userAborted) {
      if (res.ok && !aborted) {
        const latency = Date.now() - startedAt;
        useVerifyStore.getState().record(provider.id, effModel, latency > DEGRADED_MS ? 'degraded' : 'ok', latency);
      } else if (!res.ok) {
        useVerifyStore.getState().record(provider.id, effModel, 'fail', 0);
      }
    }

    const finalText = (res.ok ? res.data?.text : '') || accText;
    const finalThink = (res.ok ? res.data?.thinking : '') || accThink;
    const toolsUsed = res.ok ? (res.data?.toolsUsed?.length ? res.data.toolsUsed : accTools) : accTools;

    // Only surface the reply if the user is still viewing this chat.
    const stillHere = activeChatIdRef.current === chatId;
    const title = extractFirstTitle(finalText);
    try {
      if ((finalText || finalThink || toolsUsed.length) && res.ok && !aborted) {
        const saved = await dbCall<Message>('addMessage', {
          chatId,
          role: 'assistant',
          content: finalText,
          thinking: finalThink || null,
          model: effModel,
          tokens_in: res.data?.tokensIn ?? null,
          tokens_out: res.data?.tokensOut ?? null,
          tokens_cached: res.data?.tokensCached ?? null,
          parentId: userMsg.id,
          toolSteps: accSteps
        });
        if (thinkMs > 0) thinkDurationsRef.current[saved.id] = thinkMs;
        // A fresh answer becomes the variant on screen.
        setVariantPick((p) => ({ ...p, [userMsg.id]: saved.id }));
        (saved as any).toolsUsed = toolsUsed;
        (saved as any).toolSteps = accSteps;
        if (stillHere) setMessages((m) => [...m, saved]);
        else useUnreadStore.getState().markReply(chatId, activeChatIdRef.current);
        runAutomations('message:new', { chatId });
        if (title) {
          await dbCall('updateChat', { id: chatId, title });
          reloadChatRelated();
        }
      } else if (aborted && accText && stillHere) {
        // User pressed stop: keep whatever streamed in before the cut
        const saved = await dbCall<Message>('addMessage', {
          chatId, role: 'assistant', content: accText, thinking: accThink || null, model: effModel, parentId: userMsg.id, toolSteps: accSteps
        });
        if (thinkMs > 0) thinkDurationsRef.current[saved.id] = thinkMs;
        // A fresh answer becomes the variant on screen.
        setVariantPick((p) => ({ ...p, [userMsg.id]: saved.id }));
        (saved as any).toolsUsed = accTools;
        (saved as any).toolSteps = accSteps;
        setMessages((m) => [...m, saved]);
      } else if (!res.ok && res.error) {
        if (accText && stillHere) {
          // keep partial output visible as an unsaved preview is confusing; save it
          const saved = await dbCall<Message>('addMessage', {
            chatId, role: 'assistant', content: accText, thinking: accThink || null, model: effModel, parentId: userMsg.id, toolSteps: accSteps
          });
          if (thinkMs > 0) thinkDurationsRef.current[saved.id] = thinkMs;
        // A fresh answer becomes the variant on screen.
        setVariantPick((p) => ({ ...p, [userMsg.id]: saved.id }));
          (saved as any).toolsUsed = accTools;
          (saved as any).toolSteps = accSteps;
          setMessages((m) => [...m, saved]);
        }
        ui.toast(`${t('chat.genFailed')}: ${res.error}`, 'error');
      }
    } finally {
      // ALWAYS release the UI — even if generate/dbCall threw — otherwise the
      // send button stays disabled forever ("can't chat" bug).
      setStreaming(false);
      setStreamingTurn(null);
      setStreamText('');
      setStreamThink('');
      setStreamTools([]); setStreamSteps([]);
      reqIdRef.current = null;
      if (storyReloadTimer) { clearTimeout(storyReloadTimer); storyReloadTimer = null; }
      // Guarantee a final refresh even when a write tool finished right before
      // the reply ended (the debounce may not have fired yet).
      if (accTools.some((n) => STORY_WRITE_TOOLS.has(n))) useData.getState().reloadStory();
    }
  }

  const sendRef = useRef(send);
  sendRef.current = send;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  // Cross-view prompts (Story/Chapters/Flow/Stats "Ask AI") that arrive while
  // a generation is running used to be marked consumed and silently dropped.
  // They now queue here and flush when streaming ends.
  const pendingPromptRef = useRef<string | null>(null);
  function deliverPendingPrompt() {
    if (!pendingPromptRef.current) return;
    if (streamingRef.current) return; // wait for the in-flight generation
    const prompt = pendingPromptRef.current;
    pendingPromptRef.current = null;
    sendRef.current(undefined, prompt);
  }
  useEffect(() => {
    const handler = (e: any) => {
      if (!e.detail) return;
      const prompt = String(e.detail);
      // Consume the prompt exactly once: stamp the handshake flag so App's
      // retry loop stops. Delivery is ours — queued if currently streaming.
      (window as any).__inkwellPromptConsumed = prompt;
      pendingPromptRef.current = prompt; // latest wins
      if (streamingRef.current) useUi.getState().toast(t('chat.queuedPrompt'), 'info');
      deliverPendingPrompt();
    };
    window.addEventListener('inkwell:send-prompt', handler);
    return () => window.removeEventListener('inkwell:send-prompt', handler);
  }, []);
  // Flush a queued prompt once the current generation finishes.
  useEffect(() => {
    if (!streaming) deliverPendingPrompt();
  }, [streaming]);

  // Cross-view actions from the command palette (refs keep the closures fresh
  // even though the listeners attach once).
  const exportRef = useRef<(format: 'md' | 'json') => void>(() => {});
  exportRef.current = exportChat;
  const regenRef = useRef<() => void>(() => {});
  regenRef.current = regenLast;
  // Chat-scoped shortcuts read the transcript through a ref: the listener
  // attaches once, the messages keep changing.
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = visibleMessages;
  useEffect(() => {
    const onExport = (e: Event) => exportRef.current((e as CustomEvent).detail === 'json' ? 'json' : 'md');
    const onRegen = () => regenRef.current();
    window.addEventListener('inkwell:export-chat', onExport);
    window.addEventListener('inkwell:regen-last', onRegen);
    const onKey = (e: KeyboardEvent) => {
      const combos = (id: string) => shortcutById(id)?.keys || [];
      if (combos('regen').some((c) => matchesCombo(e, c))) {
        e.preventDefault();
        regenRef.current();
      } else if (combos('copy-last').some((c) => matchesCombo(e, c))) {
        const last = [...messagesRef.current].reverse().find((m) => m.role === 'assistant' && m.content.trim());
        if (!last) return;
        e.preventDefault();
        navigator.clipboard.writeText(last.content).then(
          () => ui.toast(t('chat.copied'), 'ok'),
          () => ui.toast(t('chat.copyFailed'), 'error')
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('inkwell:export-chat', onExport);
      window.removeEventListener('inkwell:regen-last', onRegen);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  async function abort() {
    if (reqIdRef.current) {
      await window.inkwell.abort(reqIdRef.current);
      // Release UI immediately in case the aborted request never resolves
      setStreaming(false);
      setStreamingTurn(null);
      setStreamText('');
      setStreamThink('');
      setStreamTools([]); setStreamSteps([]);
      reqIdRef.current = null;
    }
  }

  /** Every prompt version -> the turn it belongs to. */
  const slotOf = (id: string) => tx.userSlot.get(id) ?? id;

  /**
   * Delete the turns that FOLLOW this one, but keep every other version of
   * the SAME turn: restarting v1 must never delete v2 or its answer.
   */
  async function dropTurnsAfter(slot: string, lastIndex: number): Promise<Message[]> {
    const keep: Message[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (i <= lastIndex) { keep.push(m); continue; }
      const mine = m.role === 'user'
        ? slotOf(m.id) === slot
        : !!m.parent_id && slotOf(m.parent_id) === slot;
      if (mine) { keep.push(m); continue; }
      await dbCall('deleteMessage', { id: m.id });
    }
    return keep;
  }

  async function regenLast() {
    if (streaming || !chat) return;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    // Only the LAST turn may be regenerated. Picking the last assistant row
    // blindly hit an older turn whenever the newest message had no reply yet
    // (a failed/stopped request) and silently dropped that newer message.
    const uIdx = messages.findIndex((m) => m.id === lastUser.id);
    let reply: Message | null = null;
    for (let i = uIdx + 1; i < messages.length; i++) {
      if (messages[i].role === 'user') break;
      if (messages[i].role === 'assistant') reply = messages[i];
    }
    if (reply) {
      // The old reply becomes a variant of the same turn, not a deleted row.
      await regenFrom(reply);
      return;
    }
    // No reply for the last turn yet: send it, with history ending at it.
    await send(lastUser, undefined, uIdx >= 0 ? messages.slice(0, uIdx + 1) : undefined);
  }

  // Regenerate from ANY assistant turn: everything after the user turn that
  // produced it is removed and that turn is sent again (its files are re-read
  // from the DB by send()).
  // Regenerate from ANY assistant turn: the reply is asked for again, its
  // previous answers stay as versions, and only LATER turns are dropped.
  async function regenFrom(msg: Message) {
    if (streaming || !chat) return;
    const idx = messages.findIndex((m) => m.id === msg.id);
    if (idx < 0) return;
    let uIdx = idx;
    while (uIdx >= 0 && messages[uIdx].role !== 'user') uIdx--;
    if (uIdx < 0) return;
    const userMsg = messages[uIdx];
    let keepUntil = uIdx;
    for (let i = uIdx + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'user') break; // never keep a later turn
      if (m.role === 'assistant' && (!m.parent_id || m.parent_id === userMsg.id)) keepUntil = i;
    }
    const keep = await dropTurnsAfter(slotOf(userMsg.id), keepUntil);
    setMessages(keep);
    // History is the VISIBLE transcript only: an older prompt version and its
    // answers must not be sent alongside the one being regenerated.
    await send(userMsg, undefined, buildTranscript(keep, userPick, variantPick, null).visible);
  }

  async function renameChat() {
    if (!chat) return;
    const next = await textPrompt({ title: t('chat.rename'), defaultValue: chat.title, confirmLabel: t('model.save') });
    if (!next || !next.trim() || next.trim() === chat.title) return;
    await dbCall('updateChat', { id: chat.id, title: next.trim() });
    reloadChatRelated();
  }

  async function togglePin() {
    if (!chat) return;
    const pinned = Number(chat.pinned) === 1 || chat.pinned === true;
    await dbCall('updateChat', { id: chat.id, pinned: !pinned });
    reloadChatRelated();
  }

  async function resendFrom(msg: Message, source: Message[] = messages) {
    if (streaming || !chat) return;
    const idx = source.findIndex((m) => m.id === msg.id);
    if (idx < 0) return;
    // Existing replies stay as versions of this prompt: resending adds one.
    let keepUntil = idx;
    for (let i = idx + 1; i < source.length; i++) {
      const m = source[i];
      if (m.role === 'user') break; // never keep a later turn
      if (m.role === 'assistant' && (!m.parent_id || m.parent_id === msg.id)) keepUntil = i;
    }
    const keep = await dropTurnsAfter(slotOf(msg.id), keepUntil);
    setMessages(keep);
    // History must end at the resent prompt — and never include a hidden
    // prompt version that is sitting later in the array.
    await send(msg, undefined, buildTranscript(keep, userPick, variantPick, null).visible);
  }

  async function deleteMsg(id: string) {
    // Deleting mid-generation would leave the in-flight reply with nowhere to
    // land (it is appended to `messages` when the stream settles) — block it.
    if (streaming) { ui.toast(t('chat.stopFirst'), 'error'); return; }
    await dbCall('deleteMessage', { id });
    setMessages((m) => m.filter((x) => x.id !== id));
  }

  // Edit a message in place. Editing a user message resends it: everything
  // after it is removed and a fresh reply is generated from the new text.
  async function editMsg(msg: Message, newText: string) {
    if (streaming || !chat) return;
    const trimmed = newText.trim();
    if (!trimmed || trimmed === msg.content) return;
    if (msg.role !== 'user') {
      const saved = await dbCall<Message>('updateMessage', { id: msg.id, content: trimmed });
      setMessages((cur) => cur.map((x) => (x.id === msg.id ? (saved || { ...x, content: trimmed }) : x)));
      return;
    }
    // Editing FORKS a new prompt version. Overwriting the row is what made the
    // original prompt and its answers unreachable ("edit jumped to 3").
    const slot = tx.userVersions.get(msg.id)?.parentId ?? msg.id;
    const at = messages.findIndex((m) => m.id === msg.id);
    if (at < 0) return;
    // Everything after this turn answers the old prompt — drop it, as resend
    // always did; only the versions of THIS turn are kept.
    let keepUntil = at;
    for (let i = at + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'user') break;
      if (m.role === 'assistant' && (!m.parent_id || m.parent_id === msg.id)) keepUntil = i;
    }
    const keep = await dropTurnsAfter(slot, keepUntil);
    // An edit changes the words, not which files the model can see.
    const files: Array<{ name: string; kind: string; content: string }> = [];
    for (const f of msg.files || []) {
      try {
        const row = await dbCall<{ content: string }>('readMessageFile', { id: f.id });
        files.push({ name: f.name, kind: f.kind, content: row.content });
      } catch { /* attachment deleted — the version still saves */ }
    }
    const saved = await dbCall<Message>('addMessage', {
      chatId: chat.id, role: 'user', content: trimmed, parentId: msg.id, files
    });
    const next = [...keep, saved];
    const nextPick = { ...userPick, [slot]: saved.id };
    setMessages(next);
    setUserPick(nextPick);
    // The new version starts with a fresh reply count; the old one keeps its
    // answers and is one click away on the prompt arrows.
    await send(saved, undefined, buildTranscript(next, nextPick, variantPick, null).visible);
  }

  async function exportChat(format: 'md' | 'json' = 'md') {
    if (!chat) return;
    let content: string;
    let name: string;
    if (format === 'json') {
      content = JSON.stringify({
        app: 'OpenPlot AI',
        title: chat.title,
        model: chat.model || null,
        exportedAt: new Date().toISOString(),
        messages: visibleMessages.map((m) => ({ role: m.role, content: m.content, thinking: m.thinking || null, model: m.model || null, created_at: m.created_at || null }))
      }, null, 2);
      name = `${chat.title}.json`;
    } else {
      const lines = visibleMessages.map((m) => `### ${m.role === 'user' ? t('chat.you') : m.model || t('chat.assistant')}\n\n${m.content}`);
      content = `# ${chat.title}\n\n${lines.join('\n\n---\n\n')}\n`;
      name = `${chat.title}.md`;
    }
    const res = await window.inkwell.exportMarkdown(name, content);
    if (res.ok) ui.toast(t('chat.exported'), 'ok');
    else if (res.error !== 'cancelled') ui.toast(t('chat.exportFailed'), 'error');
  }

  async function deleteChat() {
    if (!chat) return;
    if (!(await confirmDialog({ title: t('confirm.deleteChat'), danger: true, confirmLabel: t('confirm.delete'), cancelLabel: t('confirm.cancel') }))) return;
    await dbCall('deleteChat', { id: chat.id });
    useUnreadStore.getState().forget(chat.id); // unread state dies with the chat
    scrollPosRef.current.delete(chat.id); // scroll memory dies with it too
    await reloadChatRelated();
    setActiveChat(null);
  }

  // "Save to chapter": opens the target picker (new chapter or append to an
  // existing one). The heavy lifting is in confirmSaveToChapter below.
  function saveToChapter(msg: Message) {
    if (savedChapters.has(msg.id)) return;
    setChapterTarget(msg);
  }

  async function confirmSaveToChapter(msg: Message, targetId: string) {
    let projectId = chat?.project_id || activeProjectId || null;
    if (!projectId) {
      const p = await createProjectUi('Untitled project');
      projectId = p.id;
    }
    const project = useData.getState().projects.find((p) => p.id === projectId);
    // Trim the scaffolding the composer's "Continue writing with AI" adds.
    const scaffold = `${t('chapters.extend')}:\n\n---\n\n`;
    const raw = msg.content;
    const body = raw.startsWith(scaffold) ? raw.slice(scaffold.length).trim() : raw.trim();

    if (targetId === 'new') {
      const count = useData.getState().chapters.filter((c) => c.project_id === projectId).length;
      await dbCall('createChapter', {
        projectId,
        title: `${chat?.title || msg.model || 'Draft'} — ${count + 1}`,
        content: body,
        status: 'draft'
      });
    } else {
      const target = useData.getState().chapters.find((c) => c.id === targetId);
      if (!target) { ui.toast(t('chat.saveChapterMissing'), 'error'); return; }
      // Snapshot the pre-append text so the merge is one click to undo.
      try {
        await dbCall('createChapterVersion', { chapterId: target.id, title: target.title, content: target.content, source: 'ai-append' });
      } catch { /* versioning is best-effort — never block the save */ }
      await dbCall('updateChapter', {
        id: target.id,
        content: target.content.trim() ? `${target.content.trimEnd()}\n\n${body}` : body
      });
    }

    await useData.getState().load();
    const totalWords = useData
      .getState()
      .chapters.filter((c) => c.project_id === projectId)
      .reduce((a, c) => a + contentWordCount(c.content), 0);
    useWriteStats.getState().recordDelta(projectId!, project?.name || '', contentWordCount(body), totalWords);
    setSavedChapters((s) => new Set(s).add(msg.id));
    setChapterTarget(null);
    ui.toast(t('chat.savedToChapter'), 'ok');
  }

  // Stable bubble callbacks: the latest logic lives in a ref, the identity
  // never changes, so `memo(MessageBubble)` actually skips re-renders while a
  // reply streams into the sibling bubble.
  const bubbleActions = useRef({ deleteMsg, editMsg, saveToChapter, regenFrom, resendFrom });
  bubbleActions.current = { deleteMsg, editMsg, saveToChapter, regenFrom, resendFrom };
  const onDeleteMessage = useCallback((m: Message) => { void bubbleActions.current.deleteMsg(m.id); }, []);
  const onEditMessage = useCallback((m: Message, text: string) => { void bubbleActions.current.editMsg(m, text); }, []);
  const onSaveMessage = useCallback((m: Message) => { bubbleActions.current.saveToChapter(m); }, []);
  // One button per bubble, two meanings: on YOUR message it resends that turn
  // (a fresh answer that stacks as a version); on a REPLY it restarts just that
  // answer. Before this, both lived on the reply and users could not tell them
  // apart.
  const onRegenMessage = useCallback((m: Message) => {
    if (m.role === 'user') void bubbleActions.current.resendFrom(m);
    else void bubbleActions.current.regenFrom(m);
  }, []);

  // Per-chat model options: union of all providers' models
  const allModels = Array.from(new Set(enabledProviders.flatMap((p) => p.models as string[])));

  // Assistant replies already saved as chapters this session (button turns
  // into a checkmark so the same text can't be duplicated by double-clicks).
  const [savedChapters, setSavedChapters] = useState<Set<string>>(new Set());
  useEffect(() => { setSavedChapters(new Set()); }, [activeChatId]);

  // Motion: only bubbles that appear *while reading* animate. Messages present
  // on load are recorded on the first non-empty render, so opening a long chat
  // does not animate the whole transcript (Task 10).
  const knownIds = useRef<Set<string>>(new Set());
  const hydrated = useRef(false);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!messages.length) return;
    if (!hydrated.current) {
      hydrated.current = true;
      knownIds.current = new Set(messages.map((m) => m.id));
      return;
    }
    const added = messages.filter((m) => !knownIds.current.has(m.id)).map((m) => m.id);
    knownIds.current = new Set(messages.map((m) => m.id));
    if (!added.length) return;
    setFreshIds(new Set(added));
    const timer = setTimeout(() => setFreshIds(new Set()), 400);
    return () => clearTimeout(timer);
  }, [messages]);
  // A chat switch is a fresh transcript: nothing on screen should animate.
  useEffect(() => { hydrated.current = false; knownIds.current = new Set(); setFreshIds(new Set()); }, [activeChatId]);

  // Context guard notice: number of turns dropped from the REQUEST (not the
  // transcript) this session. Toasted once per chat so it never nags.
  const [contextTrimmed, setContextTrimmed] = useState<number | null>(null);
  useEffect(() => { setContextTrimmed(null); }, [activeChatId]);
  useEffect(() => {
    if (contextTrimmed) ui.toast(t('chat.contextTrimmed').replace('{n}', String(contextTrimmed)), 'info');
  }, [contextTrimmed]);

  // "Save to chapter" target picker state (null = closed).
  const [chapterTarget, setChapterTarget] = useState<Message | null>(null);
  // Chapters of the chat's project — the picker's append options.
  const saveProjectId = chat?.project_id || activeProjectId || null;
  const projectChapters = allChapters
    .filter((c) => c.project_id === saveProjectId)
    .sort((a, b) => a.position - b.position);

  // ---- context meter (Task 5) ------------------------------------------
  // Cheap estimate (~4 chars/token): good enough to warn before a provider
  // rejects the request, never presented as an exact count.
  const systemTokens = useMemo(() => {
    if (!chat) return 0;
    return estimateTokens(buildSystemPrompt(chat));
  }, [
    chat?.id, chat?.project_id, ovSystem, attachments, goal,
    settings.defaultSystem, settings.agentMd, settings.memoryEnabled,
    settings.toolsEnabled, settings.defaultStyleId, toolsOn, memOn,
    chatAgentOn, chatModeOn, chat?.skills_on
  ]);
  const contextUsedTokens = useMemo(() => {
    const messagesTokens = visibleMessages.reduce(
      (n, m) => n + estimateTokens(m.content) + estimateTokens(m.thinking || ''), 0
    );
    return systemTokens + messagesTokens + estimateTokens(input);
  }, [visibleMessages, input, systemTokens]);
  const contextWindow = modelOv?.context ?? capsRecord?.caps?.contextTokens ?? 0;
  const contextPct = contextWindow > 0 ? Math.min(100, Math.round((contextUsedTokens / contextWindow) * 100)) : 0;
  const cacheProfile = inferCacheProfile(effModel || '', {
    kind: (effProvider as any)?.kind || 'auto', baseUrl: effProvider?.baseUrl
  });
  const cacheTitle = cacheProfile.mode === 'none'
    ? t('header.cacheNone')
    : cacheProfile.mode === 'unknown'
      ? t('header.cacheUnknown')
      : t(cacheProfile.mode === 'explicit' ? 'header.cacheExplicit' : 'header.cacheAuto');

  const recentChats = chats.slice(0, 3);
  const latestChapter = allChapters.slice().sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0];

  // Empty-chat starters: built from what the project actually has, so the
  // chips never promise a chapter that does not exist.
  const emptySuggestions = useMemo(() => {
    const list: Array<{ label: string; prompt: string }> = [];
    if (latestChapter) {
      list.push({
        label: t('chat.suggest.continue').replace('{title}', latestChapter.title),
        prompt: t('chat.suggest.continuePrompt').replace('{title}', latestChapter.title)
      });
    }
    if (projectChapters.length) {
      list.push({ label: t('chat.suggest.critique'), prompt: t('chat.suggest.critiquePrompt') });
    }
    if (allStory.length) {
      list.push({ label: t('chat.suggest.summarize'), prompt: t('chat.suggest.summarizePrompt') });
    }
    list.push({ label: t('chat.suggest.outline'), prompt: t('chat.suggest.outlinePrompt') });
    return list.slice(0, 4);
  }, [latestChapter, projectChapters, allStory, t]);

  async function setAgentPersist(on: boolean) {
    setAgentMode(on);
    if (!chat) return;
    await dbCall('updateChat', { id: chat.id, agent_mode: on });
    await useData.getState().reloadChatRelated();
  }

  async function setModePersist(mode: ChatMode) {
    setChatMode(mode);
    if (!chat) return;
    await dbCall('updateChat', { id: chat.id, chat_mode: mode });
    await useData.getState().reloadChatRelated();
  }

  /** Persist the thinking level so it survives switching chats or a restart. */
  async function setThinkLevelPersist(level: ThinkLevel) {
    setThinkLevel(level);
    if (level === 'auto') { setThinkOn(null); setThinkBudget(null); }
    else if (level === 'off') setThinkOn(false);
    else { setThinkOn(true); setThinkBudget(thinkLevelBudget(level) as number); }
    if (!chat) return;
    await dbCall('updateChat', { id: chat.id, think_level: level });
    await useData.getState().reloadChatRelated();
  }

  /**
   * `/skill/<name>` or `/skill/all`: switch skills on for this chat. Skills
   * ship off, so this is the normal way in — and it never becomes a message.
   */
  async function runSkillCommand(cmd: { all: true } | { name: string }) {
    if (!chat) return;
    const allSkills = useData.getState().skills;
    // One command activates its best match, not every skill the query touches.
    const picked = 'all' in cmd ? allSkills : matchSkills(allSkills, cmd.name).slice(0, 1);
    if (!picked.length) {
      ui.toast(t('skill.notFound').replace('{name}', 'name' in cmd ? cmd.name : 'all'), 'error');
      return;
    }
    const on = new Set(parseSkillsOn(chat.skills_on));
    for (const s of picked) on.add(s.id);
    const off = parseSkillsOff(chat.skills_off).filter((id) => !on.has(id));
    await dbCall('updateChat', { id: chat.id, skills_on: [...on], skills_off: off });
    setInput('');
    await useData.getState().reloadChatRelated();
    ui.toast(
      'all' in cmd
        ? t('skill.allOn').replace('{n}', String(picked.length))
        : t('skill.on').replace('{name}', picked[0].name),
      'ok'
    );
  }

  /** Per-chat skill switch (composer popover), stored on the chat row. */
  async function toggleChatSkill(skillId: string) {
    if (!chat) return;
    const off = parseSkillsOff(chat.skills_off);
    const on = parseSkillsOn(chat.skills_on);
    const skill = useData.getState().skills.find((s) => s.id === skillId);
    const active = ((!!skill && Number(skill.enabled) === 1) || on.includes(skillId)) && !off.includes(skillId);
    const nextOn = active ? on.filter((x) => x !== skillId) : (on.includes(skillId) ? on : [...on, skillId]);
    const nextOff = active ? (off.includes(skillId) ? off : [...off, skillId]) : off.filter((x) => x !== skillId);
    await dbCall('updateChat', { id: chat.id, skills_on: nextOn, skills_off: nextOff });
    await useData.getState().reloadChatRelated();
  }

  async function startFromPrompt(prompt: string, projectId?: string | null) {
    // The new chat remounts this view, so hand the draft to the next instance.
    pendingChatDraft = prompt;
    try {
      await createChatUi('New chat', projectId ?? activeProjectId);
    } catch (e) {
      pendingChatDraft = null;
      throw e;
    }
  }

  if (!chat || route === 'home') {
    return (
      <WelcomeScreen
        hasProvider={enabledProviders.length > 0}
        recentChats={recentChats}
        latestChapter={latestChapter || null}
        storyCount={allStory.length}
        effModel={effModel}
        effProvider={effProvider ? { id: effProvider.id, name: effProvider.name } : null}
        onStart={(prompt, projectId) => { void startFromPrompt(prompt, projectId ?? activeProjectId); }}
        onOpenSettings={() => useData.getState().navigate('settings')}
        onSelectChat={(id) => { setActiveChat(id); navigate('chat'); }}
      />
    );
  }

  const ov = showAdvanced;
  const pinned = Number(chat.pinned) === 1 || chat.pinned === true;
  const cacheAvailable = cacheProfile.mode === 'auto' || cacheProfile.mode === 'explicit';
  const toolsCap = toolsOn ?? settings.toolsEnabled;

  return (
    <div className={`chat-root ${headerHidden ? 'header-hidden' : ''} ${zen ? 'zen' : ''}`}>
      <div className={`chat-header ${headerScrolled ? 'scrolled' : ''}`}>
        <div className="title">{chat.title}</div>

        {/* Capability strip: what this model can do BEFORE sending, plus the
            prompt estimate so a 400 from the context limit is avoidable. */}
        <div className="chat-caps">
          {effModel && effProvider && (
            <span className="cc-model" title={`${effProvider.name} · ${effModel}`}>
              {effModel}<span className="cc-prov"> · {effProvider.name}</span>
            </span>
          )}
          <span
            className={`cap-dot ${thinkSupport === 'yes' ? 'on' : thinkSupport === 'no' ? 'off' : 'unk'}`}
            title={thinkSupport === 'yes' ? t('think.capYes') : thinkSupport === 'no' ? t('think.capNo') : t('think.capUnknown')}
          ><Icon name="brain" size={11} /></span>
          <span className={`cap-dot ${cacheProfile.mode === 'none' ? 'off' : cacheAvailable ? 'on' : 'unk'}`} title={cacheTitle}>
            <Icon name="bolt" size={11} />
          </span>
          <span className={`cap-dot ${toolsCap ? 'on' : 'off'}`} title={t('chat.tools')}>
            <Icon name="tools" size={11} />
          </span>
          <span
            className={`ctx-meter ${contextWindow > 0 && contextPct >= 80 ? 'warn' : ''}`}
            title={t('chat.contextMeter')
              .replace('{n}', String(contextUsedTokens))
              .replace('{max}', contextWindow > 0 ? fmtTokens(contextWindow) : '?')}
          >
            {contextWindow > 0 && <span className="cm-bar"><span className="cm-fill" style={{ width: `${contextPct}%` }} /></span>}
            <span className="cm-text">
              {fmtTokens(contextUsedTokens)}{contextWindow > 0 ? ` / ${fmtTokens(contextWindow)}` : ''}
            </span>
          </span>
        </div>

        <button className="small ghost" onClick={() => setModelModal(true)} title={t('model.editTitle')} aria-label={t('model.editTitle')}><Icon name="cpu" size={15} /></button>
        <button className="small ghost" onClick={() => setShowAdvanced(!showAdvanced)} title={t('advanced.title')} aria-label={t('advanced.title')}><Icon name="settings" size={15} /></button>
        <button className={`small ghost ${zen ? 'active' : ''}`} onClick={() => setZen(!zen)} title={t('chat.zen')} aria-label={t('chat.zen')}><Icon name="expand" size={15} /></button>
        <button className={`small ghost ${ui.sidebarHidden ? 'active' : ''}`} onClick={() => ui.setSidebarHidden(!ui.sidebarHidden)} title={ui.sidebarHidden ? t('chat.showSidebar') : t('chat.hideSidebar')} aria-label={ui.sidebarHidden ? t('chat.showSidebar') : t('chat.hideSidebar')}><Icon name="panelLeft" size={15} /></button>
        <button className="small ghost" onClick={regenLast} disabled={streaming} title={t('chat.regenLast')} aria-label={t('chat.regenLast')}><Icon name="refresh" size={15} /></button>

        <div className="comp-menu-wrap">
          <button className="small ghost" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen}
            title={t('chat.menu')} aria-label={t('chat.menu')}>⋯</button>
          <Popover open={menuOpen} onClose={() => setMenuOpen(false)} align="right" width={300}>
            <MenuItem icon="pencil" label={t('chat.rename')} onClick={() => { setMenuOpen(false); void renameChat(); }} />
            <MenuItem icon="pin" label={pinned ? t('chat.unpin') : t('chat.pin')} active={pinned}
              onClick={() => { setMenuOpen(false); void togglePin(); }} />
            <MenuItem icon="download" label={t('chat.export')} onClick={() => { setMenuOpen(false); void exportChat('md'); }} />
            <MenuItem icon="file" label={t('chat.exportJson')} onClick={() => { setMenuOpen(false); void exportChat('json'); }} />
            <div className="menu-field">
              <label>{t('chat.bindProject')}</label>
              <select value={chat.project_id || ''} onChange={(e) => {
                void dbCall('updateChat', { id: chat.id, project_id: e.target.value || null });
                setActiveProject(e.target.value || null);
                reloadChatRelated();
              }}>
                <option value="">{t('chat.noProject')}</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <MenuItem icon="trash" danger label={t('chat.delete')} onClick={() => { setMenuOpen(false); void deleteChat(); }} />
          </Popover>
        </div>
      </div>

      {ov && !headerHidden && (
        <div className="card" style={{ margin: '10px 16px 0', flexShrink: 0 }}>
          <div className="grid-2">
            <div className="field">
              <label>{t('advanced.system')}</label>
              <textarea rows={3} value={ovSystem || ''} onChange={(e) => setOvSystem(e.target.value)}
                onBlur={() => dbCall('updateChat', { id: chat.id, system_prompt: ovSystem })} />
            </div>
            <div className="field">
              <label>{t('advanced.project')}</label>
              <select value={chat.project_id || ''} onChange={(e) => { dbCall('updateChat', { id: chat.id, project_id: e.target.value || null }); setActiveProject(e.target.value || null); reloadChatRelated(); }}>
                <option value="">{t('advanced.none')}</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <div className="hint">{t('projects.context')}</div>
            </div>
            <div className="field"><label>{t('advanced.temperature')}: {(ovTemp ?? settings.temperature).toFixed(2)}</label>
              <input type="range" min={0} max={2} step={0.05} value={ovTemp ?? settings.temperature} onChange={(e) => setOvTemp(clampNum(Number(e.target.value), 0, 2, settings.temperature))} /></div>
            <div className="field"><label>{t('advanced.maxTokens')}</label>
              <input type="number" min={64} max={200000} value={ovMaxTok ?? settings.maxTokens} onChange={(e) => setOvMaxTok(clampNum(Number(e.target.value), 64, 200000, settings.maxTokens))} /></div>
            <div className="field"><label>{t('advanced.topP')}</label>
              <input type="number" step={0.05} min={0} max={1} value={ovTopP ?? settings.topP} onChange={(e) => setOvTopP(clampNum(Number(e.target.value), 0, 1, settings.topP))} /></div>
            <div className="field"><label>{t('think.budgetLabel')}</label>
              <input type="number" min={1024} max={maxThinkBudget} value={effThinkBudget} disabled={thinkSupport === 'no'}
                title={thinkSupport === 'no' ? t('think.capNo') : undefined}
                onChange={(e) => {
                  const v = clampNum(Number(e.target.value), 1024, maxThinkBudget, settings.thinkingBudget);
                  setThinkBudget(v);
                  void setThinkLevelPersist(budgetToThinkLevel(v));
                }} />
              <div className="hint">{t('think.budgetHint').replace('{n}', String(Math.round(maxThinkBudget / 1024)))}</div></div>
          </div>
          <div className="row" style={{ gap: 18 }}>
            <label className="toggle" title={thinkSupport === 'no' ? t('think.capNo') : undefined}><input type="checkbox" checked={effThinkOn && thinkSupport !== 'no'} disabled={thinkSupport === 'no'} onChange={(e) => { void setThinkLevelPersist(e.target.checked ? (activeThinkLevel === 'auto' || activeThinkLevel === 'off' ? 'medium' : activeThinkLevel) : 'off'); }} /> <Icon name="brain" size={14} /> {t('chat.think')}</label>
            <label className="toggle"><input type="checkbox" checked={toolsOn ?? settings.toolsEnabled} onChange={(e) => setToolsOn(e.target.checked)} /> <Icon name="tools" size={14} /> {t('chat.tools')}</label>
            <label className="toggle"><input type="checkbox" checked={memOn ?? settings.memoryEnabled} onChange={(e) => setMemOn(e.target.checked)} /> <Icon name="memory" size={14} /> {t('advanced.memory')}</label>
          </div>
          {thinkSupport === 'no' && <div className="hint" style={{ marginTop: 6 }}>{t('think.capNo')}</div>}
        </div>
      )}

      <div
        className={`messages ${dragOver ? 'drag-over' : ''}`}
        ref={scrollRef}
        onScroll={onMessagesScroll}
        style={{ fontSize: settings.chatFontSize }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={handleDrop}
      >
        {messages.length === 0 && !streaming && (
          <div className="chat-empty">
            <div className="ce-ic"><Icon name="sparkle" size={20} /></div>
            <div className="ce-title">{t('chat.emptyTitle')}</div>
            <div className="ce-sub">{t('chat.emptySub')}</div>
            <div className="ce-chips">
              {emptySuggestions.map((s, i) => (
                <button key={i} className="chip" onClick={() => setInput(s.prompt)}>{s.label}</button>
              ))}
            </div>
          </div>
        )}
        {hasOlder && (
          <button className="load-earlier" onClick={loadOlder} disabled={loadingOlder} aria-busy={loadingOlder}>
            {loadingOlder ? t('chat.loadingEarlier') : t('chat.loadOlderPage').replace('{n}', String(MESSAGE_PAGE))}
          </button>
        )}
        {renderLimit < visibleMessages.length && (
          <button className="load-earlier" onClick={expandEarlier} disabled={loadingEarlier} aria-busy={loadingEarlier}>
            {t('chat.loadEarlier').replace('{n}', String(Math.min(RENDER_WINDOW, visibleMessages.length - renderLimit)))}
          </button>
        )}
        {/* Only the render window is mounted. Older turns used to render as
            skeleton rows, which kept every message in the DOM (a 2,000-message
            chat meant 2,000 extra nodes) — now a single spacer keeps the
            scrollbar honest and the turns mount when the reader asks for
            them. */}
        {visibleMessages.length > renderLimit && (
          <div className="msg-spacer" style={{ height: (visibleMessages.length - renderLimit) * 84 }} aria-hidden />
        )}
        {visibleMessages.slice(Math.max(0, visibleMessages.length - renderLimit)).map((m) => (
          <MessageBubble key={m.id} msg={m} fresh={freshIds.has(m.id)} youLabel={t('chat.you')}
            editLabel={t('chat.edit')}
            saveResendLabel={t('chat.saveAndResend')}
            cancelLabel={t('chat.cancelEdit')}
            deleteLabel={t('chat.delete')}
            onOpenFile={openMessageFile}
            onRegen={onRegenMessage}
            regenLabel={t('chat.regenHere')}
            streaming={streaming}
            onDelete={onDeleteMessage}
            onEdit={onEditMessage}
            onSaveChapter={onSaveMessage}
            savedToChapter={savedChapters.has(m.id)}
            tokensLabel={tokenLabel(m)}
            thinkMs={thinkDurationsRef.current[m.id]}
            variant={m.role === 'user' ? tx.userVersions.get(m.id) : tx.aiVersions.get(m.id)}
            onPickVariant={m.role === 'user' ? pickUserVersion : pickVariant}
            thinkingDisplay={settings.thinkingDisplay} />
        ))}
        <StreamingBubble
          streaming={streaming}
          html={streamHtml}
          text={streamText}
          think={streamThink}
          tools={streamTools}
          steps={streamSteps}
          thinkingDisplay={settings.thinkingDisplay}
        />
      </div>

      {dragOver && (
        <div className="drop-overlay">
          <div className="do-card">
            <Icon name="paperclip" size={24} />
            <span>{t('chat.dropHint')}</span>
            <small>{t('chat.dropFormats')}</small>
          </div>
        </div>
      )}

      {unreadCount > 0 && (
        <button
          className="unread-pill"
          onClick={() => { useUnreadStore.getState().markRead(activeChatId!); stickToBottomRef.current = true; scrollToBottom(); }}
        >
          <Icon name="download" size={13} style={{ transform: 'rotate(-90deg)' }} />
          {t('chat.newReplies').replace('{n}', String(unreadCount)).replace('{s}', unreadCount === 1 ? 'y' : 'ies')}
        </button>
      )}

      {(canScrollUp || canScrollDown) && (
        <div className="scroll-nav">
          <button
            className={`scroll-btn ${canScrollUp ? '' : 'disabled'}`}
            onClick={() => scrollByAmount('up')}
            disabled={!canScrollUp}
            title={t('chat.scrollUp')}
          >
            <Icon name="chevronUp" size={16} />
          </button>
          <button
            className={`scroll-btn ${canScrollDown ? '' : 'disabled'}`}
            onClick={() => (canScrollDown ? scrollByAmount('down') : scrollToBottom())}
            disabled={!canScrollDown}
            title={canScrollDown ? t('chat.scrollDown') : t('chat.scrollBottom')}
          >
            <Icon name={canScrollDown ? 'chevronDown' : 'download'} size={16} style={{ transform: 'rotate(-90deg)' }} />
          </button>
        </div>
      )}

      <Composer
        input={input}
        setInput={setInput}
        onSend={() => send()}
        streaming={streaming}
        onAbort={abort}
        effModel={effModel}
        effProvider={effProvider}
        allModels={allModels}
        onPickModel={(m) => { setOvModel(m); if (chat) dbCall('updateChat', { id: chat.id, model: m }); }}
        thinkOn={effThinkOn}
        setThinkOn={(v) => { void setThinkLevelPersist(v ? (activeThinkLevel === 'auto' || activeThinkLevel === 'off' ? 'medium' : activeThinkLevel) : 'off'); }}
        thinkSupport={thinkSupport}
        thinkingUi={settings.thinkingUi}
        thinkBudget={effThinkBudget}
        setThinkBudget={(v) => { setThinkBudget(v); void setThinkLevelPersist(budgetToThinkLevel(v)); }}
        onPickThinkLevel={(l) => { void setThinkLevelPersist(l); }}
        thinkLevelMode={activeThinkLevel}
        maxThinkBudget={maxThinkBudget}
        agentMode={chatAgentOn}
        onToggleAgent={(v) => { void setAgentPersist(v); }}
        webSearchOn={webSearchOn}
        onToggleWebSearch={(v) => setWebSearchOn(v)}
        mode={chatModeOn}
        onPickMode={(m) => { void setModePersist(m); }}
        skillsOn={chatSkillsOn}
        onRunSkillCommand={(cmd) => { if (!streaming) void runSkillCommand(cmd); }}
        // Chip mengikuti chat saja — TANPA fallback ke activeProjectId, agar
        // tombol X (detach) benar-benar menghilangkan chip.
        chatProjectId={chat.project_id || null}
        onPickProject={(id) => { if (chat) dbCall('updateChat', { id: chat.id, project_id: id }); setActiveProject(id); reloadChatRelated(); }}
        onDetachProject={() => { if (chat) { dbCall('updateChat', { id: chat.id, project_id: null }); reloadChatRelated(); } }}
        goal={goal}
        setGoal={setGoal}
        wordCount={(input.trim().match(/\S+/g) || []).length}
        styles={styles}
        activeStyleId={settings.defaultStyleId}
        onPickStyle={(id) => settings.set('defaultStyleId', id)}
        chatSkillsOff={parseSkillsOff(chat?.skills_off)}
        onToggleSkill={toggleChatSkill}
        chatId={chat?.id || null}
        attachments={attachments}
        onRemoveAttachment={removeAttachment}
        onAttachClick={async () => {
          const paths = await window.inkwell.pickFiles();
          if (!paths.length) return;
          const files = await window.inkwell.readFiles(paths);
          if (files.length) addAttachments(files.map((f) => ({ id: uid(), name: f.name, kind: 'file' as const, content: f.content })));
        }}
      />

      {filePreview && (
        <FilePreviewModal
          name={filePreview.name}
          kind={filePreview.kind}
          bytes={filePreview.bytes}
          content={filePreview.content}
          loading={filePreview.loading}
          error={filePreview.error}
          onClose={() => setFilePreview(null)}
        />
      )}

      {modelModal && effModel && effProvider && (
        // Guard: modal tanpa provider tidak punya key override yang valid.
        <ModelSettingsModal
          provider={effProvider}
          model={effModel}
          onClose={() => setModelModal(false)}
          onSave={(ov) => {
            const mo = { ...settings.modelOverrides };
            const k = `${effProvider!.id}::${effModel}`;
            if (ov) mo[k] = ov; else delete mo[k];
            settings.set('modelOverrides', mo);
            setModelModal(false);
            ui.toast(t('toast.saved'), 'ok');
          }}
        />
      )}

      {chapterTarget && (
        <SaveChapterModal
          chapters={projectChapters}
          onClose={() => setChapterTarget(null)}
          onConfirm={(id) => { void confirmSaveToChapter(chapterTarget, id); }}
        />
      )}
    </div>
  );
}
