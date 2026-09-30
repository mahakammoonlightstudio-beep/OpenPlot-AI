import { useEffect, useRef, useState, useCallback } from 'react';
import { useData, useSettings, useUi, dbCall, uid, runAutomations, createChatUi, DONATE_URL, SAWERIA_URL, getModelOverride } from '../store';
import { Chat, Message, Provider, GenerateRequest, GenChunk } from '../types';
import { useMarkdown, useThrottledMarkdown, extractFirstTitle, hardenLinks } from '../markdown';
import { useT } from '../i18nReact';
import { Icon } from './Icons';
import { useVerifyStore } from '../verifyStore';
import { ModelStatusBar } from './ModelStatusBar';
import { useUnreadStore } from '../unreadStore';
import { Composer } from './Composer';
import { ModelSettingsModal } from './ModelSettingsModal';
import { Modal } from './Ui';
import { confirmDialog } from './TextPrompt';
import { expandMentions, buildCandidates, MentionCandidate, MentionKind } from '../mentions';
import { useWriteStats } from '../writeStats';

const DEGRADED_MS = 6000;

function clampNum(v: number, min: number, max: number, fb: number): number {
  if (!Number.isFinite(v)) return fb;
  return Math.min(max, Math.max(min, v));
}

const contentWordCount = (s: string) => (s.trim().match(/\S+/g) || []).length;

/** One file/story/chapter attached to the NEXT message (chip, not inline text). */
interface Attachment { id: string; name: string; kind: 'file' | 'story' | 'chapter'; content: string }

function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

/** Compact "in→out" token label for a message meta row ('' when unknown). */
function tokenLabel(m: Message): string {
  const i = fmtTokens(m.tokens_in);
  const o = fmtTokens(m.tokens_out);
  if (i && o) return `${i}→${o} tok`;
  if (o) return `${o} tok`;
  if (i) return `${i} tok`;
  return '';
}

// ---- context guard ----
// Rough token estimate (~4 chars/token) is good enough for guarding; exact
// tokenization is model-specific and not worth a dependency. When the
// estimated prompt exceeds the model's context window minus the output
// reserve, the OLDEST turns are dropped from the request (never from the DB
// or the transcript) and the user is told once per chat.
const CHARS_PER_TOKEN = 4;
const GUARD_SAFETY_TOKENS = 256; // headroom for provider-side counting drift
const GUARD_MIN_HISTORY = 4; // always keep at least this many newest turns

function estimateTokens(s: string): number {
  return Math.ceil((s || '').length / CHARS_PER_TOKEN);
}

function ThinkingBlock({ text, live }: { text: string; live?: boolean }) {
  const t = useT();
  // Auto-open while streaming so users see reasoning arrive live; when the
  // reply completes (live=false) it collapses back to the compact header.
  const [open, setOpen] = useState(!!live);
  useEffect(() => { if (live) setOpen(true); }, [live]);
  useEffect(() => { if (!live) setOpen(false); }, [live]);
  return (
    <div className="thinking-block">
      <div className="tb-head" onClick={() => setOpen(!open)} role="button" tabIndex={0} aria-expanded={open}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}>
        <Icon name="brain" size={14} />
        <span style={{ flex: 1 }}>{open ? t('chat.hideThinking') : live ? t('chat.thinking') : t('chat.thoughtProcess')}</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
      </div>
      {open && <div className="tb-body">{text}</div>}
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      className="small ghost"
      title={t('chat.copy')}
      aria-label={t('chat.copy')}
      onClick={() => {
        navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={14} />
    </button>
  );
}

function ModelBadge({ model, withBar }: { model: string | null | undefined; withBar?: boolean }) {
  const t = useT();
  const { results, pending, history } = useVerifyStore();
  // Subscribe to providers so a badge reacts when providers/models change;
  // getState() here went stale and showed wrong health forever.
  const providers = useData((s) => s.providers);
  if (!model) return null;
  const provider = providers.find((p) => (Array.isArray(p.models) ? p.models : []).includes(model));
  const key = provider ? `${provider.id}::${model}` : null;
  const entry = key ? results[key] : undefined;
  const checking = key ? pending.has(key) : false;
  const events = key ? (history[key] || []) : [];
  const okCount = events.filter((e) => e.state === 'ok').length;
  const degradedCount = events.filter((e) => e.state === 'degraded').length;
  const failCount = events.filter((e) => e.state === 'fail').length;
  const reliability = events.length ? Math.round(((okCount + degradedCount * 0.5) / events.length) * 100) : null;
  // After a restart there is no one-shot `entry`, but history survives in
  // localStorage — derive the dot color from the newest recorded event so the
  // badge doesn't flash "unknown" for models that were verified yesterday.
  const lastState = events.length ? events[events.length - 1].state : null;
  const status = checking ? 'pending'
    : entry ? (entry.ok ? 'ok' : 'fail')
    : lastState === 'ok' || lastState === 'degraded' ? 'ok'
    : lastState === 'fail' ? 'fail'
    : 'unknown';
  const tooltip = checking ? t('health.verifying')
    : entry?.ok ? `${t('health.verified')} — ${entry.latencyMs}ms${reliability !== null ? ` · ${reliability}% ${t('health.ofLast')} ${events.length} ${t('health.checks')}` : ''}`
    : entry ? `${t('health.lastFailed')}: ${entry.error || 'error'}`
    : t('health.notVerified');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span className={`model-badge st-${status}`} title={tooltip}>
        <span className="dot" />
        {model}
      </span>
      {withBar && provider && (
        <span className="model-health">
          <ModelStatusBar providerId={provider.id} model={model} />
        </span>
      )}
    </span>
  );
}

// Messages above the visible window render as cheap skeletons until the user
// scrolls up — keeps long chats fast without breaking autoscroll anchoring.
const RENDER_WINDOW = 60;

function MessageBubble({ msg, onDelete, onEdit, youLabel, editLabel, saveResendLabel, cancelLabel, deleteLabel, onSaveChapter, savedToChapter, tokensLabel }: {
  msg: Message;
  onDelete: () => void;
  onEdit: (msg: Message, newText: string) => void;
  youLabel: string;
  editLabel: string;
  saveResendLabel: string;
  cancelLabel: string;
  deleteLabel: string;
  onSaveChapter?: (msg: Message) => void;
  savedToChapter?: boolean;
  tokensLabel?: string;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.content);
  const html = useMarkdown(msg.content);
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (contentRef.current) hardenLinks(contentRef.current);
  }, [html]);
  const isUser = msg.role === 'user';
  const toolsUsed: string[] = (msg as any).toolsUsed || [];
  return (
    <div className={`msg ${msg.role}`}>
      <div className="avatar"><Icon name={isUser ? 'user' : 'quill'} size={15} /></div>
      <div className="bubble">
        <div className="meta">
          <span className="who">{isUser ? youLabel : <ModelBadge model={msg.model} />}</span>
          {tokensLabel && <span className="tok-chip">{tokensLabel}</span>}
        </div>
        {!isUser && msg.thinking ? <ThinkingBlock text={msg.thinking} /> : null}
        {!isUser && toolsUsed.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {toolsUsed.map((n, i) => (
              <span key={i} className="tool-chip"><span className="tname">{n}</span> ok</span>
            ))}
          </div>
        )}
        {editing && isUser ? (
          <div className="edit-box">
            <textarea
              value={draft}
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setEditing(false); onEdit(msg, draft); }
                else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setDraft(msg.content); }
              }}
              autoFocus
            />
            <div className="edit-actions">
              <button className="small primary" onClick={() => { setEditing(false); onEdit(msg, draft); }}>{saveResendLabel}</button>
              <button className="small ghost" onClick={() => { setEditing(false); setDraft(msg.content); }}>{cancelLabel}</button>
            </div>
          </div>
        ) : (
          <div className="content" ref={contentRef} dangerouslySetInnerHTML={{ __html: html }} />
        )}
        <div className="actions">
          {!editing && <CopyBtn text={msg.content} />}
          {isUser ? <button className="small ghost" title={editLabel} onClick={() => { setDraft(msg.content); setEditing(true); }}><Icon name="pencil" size={14} /></button> : null}
          {!isUser && onSaveChapter && (
            <button
              className="small ghost"
              title={t('chat.saveChapter')}
              aria-label={t('chat.saveChapter')}
              disabled={savedToChapter || !msg.content.trim()}
              onClick={() => onSaveChapter(msg)}
            >
              <Icon name={savedToChapter ? 'check' : 'book'} size={14} />
            </button>
          )}
          <button className="small ghost" title={deleteLabel} aria-label={deleteLabel} onClick={onDelete}><Icon name="trash" size={14} /></button>
        </div>      </div>
    </div>
  );
}

export function ChatView() {
  const t = useT();
  const settings = useSettings();
  const { chats, projects, providers, styles, activeChatId, setActiveChat, activeProjectId, setActiveProject, reloadChatRelated } = useData();
  const ui = useUi();

  const chat = chats.find((c) => c.id === activeChatId) || null;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamThink, setStreamThink] = useState('');
  const [streamTools, setStreamTools] = useState<string[]>([]);
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
          if (activeChatId) { map[activeChatId] = next; localStorage.setItem('openplot.renderLimit.v1', JSON.stringify(map)); }
        } catch { /* storage full — expansion still works this session */ }
        return next;
      });
      setLoadingEarlier(false);
    }, 160));
  }

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [modelModal, setModelModal] = useState(false);
  const enabledProviders = providers.filter((p) => p.enabled);

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
  const [toolsOn, setToolsOn] = useState<boolean | null>(null);
  const [memOn, setMemOn] = useState<boolean | null>(null);
  // Session goal pinned from the composer ADD panel — injected into every
  // system prompt until cleared (null = no goal).
  const [goal, setGoal] = useState<string | null>(null);
  useEffect(() => { setGoal(null); }, [activeChatId]);

  // ---- attachments: files & story content as chips (never inline text) ----
  // OS files keep their whole content; story bible entries and chapters can
  // be dragged straight from their views. At send time they ride in the
  // system prompt as fenced blocks and the composer text stays clean.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => { setAttachments([]); setDragOver(false); }, [activeChatId]);

  function addAttachments(next: Attachment[]) {
    setAttachments((cur) => {
      const room = Math.max(0, 8 - cur.length);
      if (next.length > room) ui.toast(t('chat.attachLimit'), 'error');
      return [...cur, ...next.slice(0, room)];
    });
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
    setThinkOn(null); setThinkBudget(null); setToolsOn(null); setMemOn(null);
    dbCall<Message[]>('getMessages', { chatId: chat.id }).then((rows) => {
      if (!cancelled) setMessages(rows);
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
    if (chatId) scrollPosRef.current.set(chatId, st);

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

  const effModel = ovModel ?? settings.defaultModel ?? null;
  // Resolve the provider that OWNS the selected model — never fall back to a
  // random enabled provider, or the request 404s against the wrong endpoint.
  const effProvider: Provider | null =
    enabledProviders.find((p) => (Array.isArray(p.models) ? p.models : []).includes(effModel || '')) || null;
  // Per-model tuning from the Edit-model modal (context/maxTokens/temp/topP/budget).
  const modelOv = getModelOverride(settings.modelOverrides, effProvider?.id, effModel);

  function buildSystemPrompt(chatRow: Chat): string {
    const parts: string[] = [];
    if (ovSystem && ovSystem.trim()) parts.push(ovSystem.trim());
    else if (settings.defaultSystem?.trim()) parts.push(settings.defaultSystem.trim());
    if (settings.agentMd?.trim()) parts.push('# agent.md\n' + settings.agentMd.trim());
    const project = projects.find((p) => p.id === (chatRow.project_id || activeProjectId));
    if (project) {
      // Work format + content rating steer length targets and tone. Values are
      // whitelisted — old rows or bad data simply fall through to no injection.
      const fmtLabel: Record<string, string> = {
        'short-story': 'a short story (aim for a compact, single-arc piece)',
        novel: 'a novel (long-form; keep chapters and pacing novel-scale)',
        book: 'a full book / series (track long arcs and continuity)',
        fanfic: 'fan fiction (respect the source material while adding new angles)',
        script: 'a script / screenplay (use scene headings and dialogue-first prose)'
      };
      const ratingLabel: Record<string, string> = {
        family: 'CONTENT RATING: family-friendly. Keep everything suitable for all ages; no graphic violence, no sexual content, mild peril only.',
        teen: 'CONTENT RATING: teen. Mild profanity at most; violence and themes may be darker but non-graphic; no explicit sexual content.',
        mature: 'CONTENT RATING: mature. Adult themes, strong language, and graphic violence are allowed when the story calls for it; keep sexual content non-explicit (fade to black).'
      };
      const fmt = fmtLabel[(project as any).format];
      if (fmt) parts.push('# Work format\nThis project is ' + fmt + '.');
      const rating = ratingLabel[(project as any).rating];
      if (rating) parts.push('# ' + rating);
    }
    if (project?.context?.trim()) parts.push('# Project: ' + project.name + '\n' + project.context.trim());
    // memoryEnabled gates injection; autoMemory only governs agent auto-saving
    if (memOn ?? settings.memoryEnabled) {
      const mems = useData.getState().memories;
      if (mems.length) {
        parts.push('# Long-term memory\n' + mems.map((m) => '- ' + m.content).join('\n'));
      }
    }
    const skills = useData.getState().skills.filter((s) => Number(s.enabled) === 1);
    if (skills.length) {
      parts.push('# Active skills\n' + skills.map((s) => `## skill: ${s.name}\n${s.content}`).join('\n\n'));
    }
    if (goal && goal.trim()) parts.push('# Session goal\n' + goal.trim());
    // Reply style (Claude-style): a named persona/tone the user picks in the
    // composer and edits in Settings. Builtin = shipped with the app.
    const style = useData.getState().styles.find((s) => s.id === settings.defaultStyleId);
    const styleName = style?.name || null;
    if (style) parts.push('# Reply style' + (style.builtin ? '' : ' (custom)') + '\n' + style.content);
    // Only advertise tools when they will actually be sent to the provider —
    // the old hint told models to "use tools proactively" even when the
    // tools toggle was off, and they replied with unusable tool-call text.
    if (toolsOn ?? settings.toolsEnabled) {
      const toolNames = 'save_memory, list_memories, create_story_entry, update_story_entry, search_story, read_story_bible, create_chapter, update_chapter, append_to_chapter, list_chapters, read_chapter, list_projects, read_project';
      const toolHint = styleName
        ? `You have native story tools (${toolNames}). When a tool result comes back, write the surrounding reply in the user's "${styleName}" style — but tool calls themselves stay plain and functional. Use tools proactively when the user discusses story worldbuilding, characters, items, lore or chapters.`
        : `You have native tools (${toolNames}). Use them proactively when the user discusses story worldbuilding, characters, items, lore or chapters.`;
      parts.push('# Story tools\n' + toolHint);
    }
    if (attachments.length) {
      const blocks = attachments.map((a) => `=== FILE: ${a.name} ===\n${a.content}`).join('\n\n');
      parts.push(`# Attached files (${attachments.length}) — user-provided context for this turn\n${blocks}`);
    }
    return parts.join('\n\n');
  }

  async function send(pendingUser?: Message, textOverride?: string, historyBase?: Message[]) {
    if (streaming) return;
    const text = (textOverride ?? input).trim();
    // Attachments alone (no typed text) are a valid send.
    if (!pendingUser && !text && !attachments.length) return;

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
      ui.toast(`${effProvider.name}: ${t('providers.baseUrl')} is missing — fix it in Settings → AI Providers.`, 'error');
      return;
    }

    const chatRow = await ensureChat();
    const chatId = chatRow.id;

    let userMsg = pendingUser;
    if (!userMsg) {
      userMsg = await dbCall<Message>('addMessage', { chatId, role: 'user', content: text });
      setMessages((m) => [...m, userMsg!]);
      setInput('');
      // Attachments rode along with this send — the next message starts clean.
      setAttachments([]);
    }

    // auto title from first user message
    if (chatRow.title === 'New chat' && userMsg) {
      const auto = userMsg.content.slice(0, 40).trim() || 'New chat';
      await dbCall('updateChat', { id: chatId, title: auto });
      reloadChatRelated();
    }

    // Build history: when regenerating/resending, `pendingUser` is already in
    // `messages` — dedupe by id so it isn't sent twice. `historyBase` lets
    // callers pass a trimmed snapshot: the state closure still contains rows
    // that were just deleted (old assistant reply on regen), which must not
    // leak into the model's context.
    const base = historyBase ?? messages;
    const prior = pendingUser ? base.filter((m) => m.id !== pendingUser.id) : base;
    const history: Message[] = [...prior, userMsg];

    const sys = buildSystemPrompt(chatRow);
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
      const maxOut = ovMaxTok ?? modelOv?.maxTokens ?? settings.maxTokens;
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
      provider: {
        id: provider.id, name: provider.name, baseUrl: provider.baseUrl,
        apiKey: provider.apiKey, enabled: true, models: provider.models as string[], kind: (provider as any).kind
      },
      model: effModel,
      messages: payloadMessages,
      temperature: ovTemp ?? modelOv?.temperature ?? settings.temperature,
      maxTokens: ovMaxTok ?? modelOv?.maxTokens ?? settings.maxTokens,
      topP: ovTopP ?? modelOv?.topP ?? settings.topP,
      thinkingEnabled: thinkOn ?? settings.thinkingEnabled,
      thinkingBudget: thinkBudget ?? modelOv?.thinkBudget ?? settings.thinkingBudget,
      toolsEnabled: toolsOn ?? settings.toolsEnabled,
      projectId: chatRow.project_id || activeProjectId || null
    };

    reqIdRef.current = req.reqId;
    setStreaming(true);
    setStreamText('');
    setStreamThink('');
    setStreamTools([]);
    stickToBottomRef.current = true;

    let accText = '';
    let accThink = '';
    const accTools: string[] = [];
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
    const off = window.inkwell.onAiChunk(({ reqId, chunk }) => {
      if (reqId !== req.reqId) return;
      const c = chunk as GenChunk;
      if (c.type === 'text') { accText += c.text || ''; dirtyText = accText; }
      else if (c.type === 'thinking') { accThink += c.text || ''; dirtyThink = accThink; }
      else if (c.type === 'replaceText') { accText = c.text || ''; dirtyText = accText; }
      else if (c.type === 'tool' && c.tool) { accTools.push(c.tool.name); setStreamTools((a) => [...a, c.tool!.name]); }
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
          tokens_out: res.data?.tokensOut ?? null
        });
        (saved as any).toolsUsed = toolsUsed;
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
          chatId, role: 'assistant', content: accText, thinking: accThink || null, model: effModel
        });
        (saved as any).toolsUsed = accTools;
        setMessages((m) => [...m, saved]);
      } else if (!res.ok && res.error) {
        if (accText && stillHere) {
          // keep partial output visible as an unsaved preview is confusing; save it
          const saved = await dbCall<Message>('addMessage', {
            chatId, role: 'assistant', content: accText, thinking: accThink || null, model: effModel
          });
          (saved as any).toolsUsed = accTools;
          setMessages((m) => [...m, saved]);
        }
        ui.toast(`${t('chat.genFailed')}: ${res.error}`, 'error');
      }
    } finally {
      // ALWAYS release the UI — even if generate/dbCall threw — otherwise the
      // send button stays disabled forever ("can't chat" bug).
      setStreaming(false);
      setStreamText('');
      setStreamThink('');
      setStreamTools([]);
      reqIdRef.current = null;
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
  useEffect(() => {
    const onExport = (e: Event) => exportRef.current((e as CustomEvent).detail === 'json' ? 'json' : 'md');
    const onRegen = () => regenRef.current();
    window.addEventListener('inkwell:export-chat', onExport);
    window.addEventListener('inkwell:regen-last', onRegen);
    return () => {
      window.removeEventListener('inkwell:export-chat', onExport);
      window.removeEventListener('inkwell:regen-last', onRegen);
    };
  }, []);

  async function abort() {
    if (reqIdRef.current) {
      await window.inkwell.abort(reqIdRef.current);
      // Release UI immediately in case the aborted request never resolves
      setStreaming(false);
      setStreamText('');
      setStreamThink('');
      setStreamTools([]);
      reqIdRef.current = null;
    }
  }

  async function regenLast() {
    if (streaming || !chat) return;
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    if (lastAssistant) {
      await dbCall('deleteMessage', { id: lastAssistant.id });
      setMessages((m) => m.filter((x) => x.id !== lastAssistant.id));
    }
    // History = everything up to & including the last user message. Without
    // this slice, the stale closure re-sends the reply we just deleted and
    // the model just parrots its old answer back.
    const idx = messages.findIndex((m) => m.id === lastUser.id);
    await send(lastUser, undefined, idx >= 0 ? messages.slice(0, idx + 1) : undefined);
  }

  async function resendFrom(msg: Message) {
    if (streaming || !chat) return;
    const idx = messages.findIndex((m) => m.id === msg.id);
    if (idx < 0) return;
    const after = messages.slice(idx + 1);
    for (const m of after) await dbCall('deleteMessage', { id: m.id });
    setMessages(messages.slice(0, idx + 1));
    // Same stale-closure guard as regenLast: history must end at the resent
    // message, not include the rows we just deleted from the DB.
    await send(msg, undefined, messages.slice(0, idx + 1));
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
    const saved = await dbCall<Message>('updateMessage', { id: msg.id, content: trimmed });
    setMessages((ms) => ms.map((x) => (x.id === msg.id ? (saved || { ...x, content: trimmed }) : x)));
    if (msg.role === 'user') await resendFrom({ ...msg, content: trimmed });
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
        messages: messages.map((m) => ({ role: m.role, content: m.content, thinking: m.thinking || null, model: m.model || null, created_at: m.created_at || null }))
      }, null, 2);
      name = `${chat.title}.json`;
    } else {
      const lines = messages.map((m) => `### ${m.role === 'user' ? t('chat.you') : m.model || t('chat.assistant')}\n\n${m.content}`);
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
      const p = await dbCall<any>('createProject', { name: 'Untitled project' });
      await useData.getState().load();
      useData.getState().setActiveProject(p.id);
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

  // Per-chat model options: union of all providers' models
  const allModels = Array.from(new Set(enabledProviders.flatMap((p) => p.models as string[])));

  // Assistant replies already saved as chapters this session (button turns
  // into a checkmark so the same text can't be duplicated by double-clicks).
  const [savedChapters, setSavedChapters] = useState<Set<string>>(new Set());
  useEffect(() => { setSavedChapters(new Set()); }, [activeChatId]);

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
  const projectChapters = useData((s) => s.chapters)
    .filter((c) => c.project_id === saveProjectId)
    .sort((a, b) => a.position - b.position);

  if (!chat) {
    return (
      <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="welcome-hero">
          <div className="logo-big">Open<span className="ink">Plot</span>&nbsp;AI</div>
          <p>{t('chat.welcomeSub')}</p>
        </div>
        <div className="welcome-cards">
          <div className="welcome-card" onClick={newChat}>
            <div className="ic"><Icon name="chat" size={22} /></div>
            <div className="t">{t('app.newChat')}</div>
            <div className="d">{t('chat.welcomeStart')}</div>
          </div>
          <div className="welcome-card" onClick={() => useData.getState().navigate('story')}>
            <div className="ic"><Icon name="book" size={22} /></div>
            <div className="t">{t('app.story')}</div>
            <div className="d">{t('chat.welcomeStory')}</div>
          </div>
          <div className="welcome-card" onClick={() => useData.getState().navigate('settings')}>
            <div className="ic"><Icon name="settings" size={22} /></div>
            <div className="t">{t('app.settings')}</div>
            <div className="d">{t('chat.welcomeSettings')}</div>
          </div>
          <div className="welcome-card" onClick={() => window.inkwell.openExternal(DONATE_URL)}>
            <div className="ic"><Icon name="donate" size={22} /></div>
            <div className="t">{t('app.donate')}</div>
            <div className="d">{t('chat.welcomeDonate')}</div>
          </div>
          <div className="welcome-card" onClick={() => window.inkwell.openExternal(SAWERIA_URL)}>
            <div className="ic"><Icon name="heart" size={22} /></div>
            <div className="t">Saweria</div>
            <div className="d">{t('chat.welcomeDonate2')}</div>
          </div>
        </div>
      </div>
    );
  }

  const ov = showAdvanced;

  return (
    <div className={`chat-root ${headerHidden ? 'header-hidden' : ''} ${zen ? 'zen' : ''}`}>
      <div className={`chat-header ${headerScrolled ? 'scrolled' : ''}`}>
        <div className="title">{chat.title}</div>
        {effModel && effProvider && <ModelBadge model={effModel} withBar />}
        <button className="small ghost" onClick={() => setModelModal(true)} title={t('model.editTitle')} aria-label={t('model.editTitle')}><Icon name="cpu" size={15} /></button>
        <button className="small ghost" onClick={() => setShowAdvanced(!showAdvanced)} title="Advanced settings" aria-label="Advanced settings"><Icon name="settings" size={15} /></button>
        <button className={`small ghost ${zen ? 'active' : ''}`} onClick={() => setZen(!zen)} title={t('chat.zen')} aria-label={t('chat.zen')}><Icon name="expand" size={15} /></button>
        <button className={`small ghost ${ui.sidebarHidden ? 'active' : ''}`} onClick={() => ui.setSidebarHidden(!ui.sidebarHidden)} title={ui.sidebarHidden ? t('chat.showSidebar') : t('chat.hideSidebar')} aria-label={ui.sidebarHidden ? t('chat.showSidebar') : t('chat.hideSidebar')}><Icon name="panelLeft" size={15} /></button>
        <button className="small ghost" onClick={regenLast} disabled={streaming} title={t('chat.regenLast')} aria-label={t('chat.regenLast')}><Icon name="refresh" size={15} /></button>
        <button className="small ghost" onClick={() => exportChat('md')} disabled={messages.length === 0} title={t('chat.export')} aria-label={t('chat.export')}><Icon name="download" size={15} /></button>
        <button className="small ghost" onClick={() => exportChat('json')} disabled={messages.length === 0} title={t('chat.exportJson')} aria-label={t('chat.exportJson')}><Icon name="file" size={15} /></button>
        <button className="small ghost danger" onClick={deleteChat} title={t('chat.delete')} aria-label={t('chat.delete')}><Icon name="trash" size={15} /></button>
      </div>

      {ov && !headerHidden && (
        <div className="card" style={{ margin: '10px 16px 0', flexShrink: 0 }}>
          <div className="grid-2">
            <div className="field">
              <label>System prompt (this chat)</label>
              <textarea rows={3} value={ovSystem || ''} onChange={(e) => setOvSystem(e.target.value)}
                onBlur={() => dbCall('updateChat', { id: chat.id, system_prompt: ovSystem })} />
            </div>
            <div className="field">
              <label>Project</label>
              <select value={chat.project_id || ''} onChange={(e) => { dbCall('updateChat', { id: chat.id, project_id: e.target.value || null }); setActiveProject(e.target.value || null); reloadChatRelated(); }}>
                <option value="">— none —</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <div className="hint">{t('projects.context')}</div>
            </div>
            <div className="field"><label>Temperature: {(ovTemp ?? settings.temperature).toFixed(2)}</label>
              <input type="range" min={0} max={2} step={0.05} value={ovTemp ?? settings.temperature} onChange={(e) => setOvTemp(clampNum(Number(e.target.value), 0, 2, settings.temperature))} /></div>
            <div className="field"><label>Max tokens</label>
              <input type="number" min={64} max={200000} value={ovMaxTok ?? settings.maxTokens} onChange={(e) => setOvMaxTok(clampNum(Number(e.target.value), 64, 200000, settings.maxTokens))} /></div>
            <div className="field"><label>Top P</label>
              <input type="number" step={0.05} min={0} max={1} value={ovTopP ?? settings.topP} onChange={(e) => setOvTopP(clampNum(Number(e.target.value), 0, 1, settings.topP))} /></div>
            <div className="field"><label>Thinking budget (tokens)</label>
              <input type="number" min={1024} max={100000} value={thinkBudget ?? settings.thinkingBudget} onChange={(e) => setThinkBudget(clampNum(Number(e.target.value), 1024, 100000, settings.thinkingBudget))} /></div>
          </div>
          <div className="row" style={{ gap: 18 }}>
            <label className="toggle"><input type="checkbox" checked={thinkOn ?? settings.thinkingEnabled} onChange={(e) => setThinkOn(e.target.checked)} /> <Icon name="brain" size={14} /> {t('chat.think')}</label>
            <label className="toggle"><input type="checkbox" checked={toolsOn ?? settings.toolsEnabled} onChange={(e) => setToolsOn(e.target.checked)} /> <Icon name="tools" size={14} /> {t('chat.tools')}</label>
            <label className="toggle"><input type="checkbox" checked={memOn ?? settings.memoryEnabled} onChange={(e) => setMemOn(e.target.checked)} /> <Icon name="memory" size={14} /> Memory</label>
          </div>
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
        {renderLimit < messages.length && (
          <button className="load-earlier" onClick={expandEarlier} disabled={loadingEarlier} aria-busy={loadingEarlier}>
            {t('chat.loadEarlier').replace('{n}', String(Math.min(RENDER_WINDOW, messages.length - renderLimit)))}
          </button>
        )}
        {messages.map((m, idx) => (
          idx >= messages.length - renderLimit ? (
            <MessageBubble key={m.id} msg={m} youLabel={t('chat.you')}
              editLabel={t('chat.edit')}
              saveResendLabel={t('chat.saveAndResend')}
              cancelLabel={t('chat.cancelEdit')}
              deleteLabel={t('chat.delete')}
              onDelete={() => deleteMsg(m.id)}
              onEdit={editMsg}
              onSaveChapter={() => saveToChapter(m)}
              savedToChapter={savedChapters.has(m.id)}
              tokensLabel={tokenLabel(m)} />
          ) : (
            <div key={m.id} className="msg skeleton-msg"><div className="avatar" /><div className="bubble"><div className="skeleton-line" /></div></div>
          )
        ))}
        {streaming && (
          <div className="msg assistant streaming">
            <div className="avatar"><Icon name="quill" size={15} /></div>
            <div className="bubble">
              {streamThink && <ThinkingBlock text={streamThink} live />}
              {streamTools.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  {streamTools.map((n, i) => <span key={i} className="tool-chip"><span className="tname">{n}</span></span>)}
                </div>
              )}
              {streamText
                ? <div className="content" dangerouslySetInnerHTML={{ __html: streamHtml }} />
                : <div className="typing-dots"><span /><span /><span /></div>}
            </div>
          </div>
        )}
      </div>

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
        thinkOn={thinkOn ?? settings.thinkingEnabled}
        setThinkOn={setThinkOn}
        toolsOn={toolsOn ?? settings.toolsEnabled}
        setToolsOn={setToolsOn}
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
        attachments={attachments}
        onRemoveAttachment={removeAttachment}
        onAttachClick={async () => {
          const paths = await window.inkwell.pickFiles();
          if (!paths.length) return;
          const files = await window.inkwell.readFiles(paths);
          if (files.length) addAttachments(files.map((f) => ({ id: uid(), name: f.name, kind: 'file' as const, content: f.content })));
        }}
      />

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
        <Modal
          title={t('chat.saveChapterTitle')}
          onClose={() => setChapterTarget(null)}
          width={520}
        >
          <div className="hint" style={{ marginBottom: 12 }}>{t('chat.saveChapterHint')}</div>
          <button className="primary" style={{ width: '100%', marginBottom: 14 }} onClick={() => confirmSaveToChapter(chapterTarget, 'new')}>
            <Icon name="plus" size={14} /> {t('chat.saveChapterNew')}
          </button>
          <div className="pick-label">{t('chat.saveChapterAppend')}</div>
          {projectChapters.length === 0 && <div className="hint">{t('chat.saveChapterNone')}</div>}
          {projectChapters.map((c) => (
            <button key={c.id} className="pick-chapter-row" onClick={() => confirmSaveToChapter(chapterTarget, c.id)}>
              <span className="t">{c.title}</span>
              <span className="w">{contentWordCount(c.content).toLocaleString()}w</span>
            </button>
          ))}
        </Modal>
      )}
    </div>
  );
}
