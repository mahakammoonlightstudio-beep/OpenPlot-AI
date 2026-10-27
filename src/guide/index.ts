/**
 * Guide bundle. Articles are real Markdown files under `guide/en` and
 * `guide/id`, imported statically with Vite's `?raw` loader — the files are
 * inlined into the bundle, so the guide works offline and in a packaged app
 * with no filesystem access.
 *
 * Static imports (rather than `import.meta.glob`) keep the same module usable
 * from the headless render bundle, which does not know Vite's glob API; a
 * missing file is a compile error instead of a silently short guide.
 */
import { parseArticle, sortDocs, type GuideDoc, type GuideLang } from './content';
import en_agent_md from './en/agent-md.md?raw';
import en_automations from './en/automations.md?raw';
import en_chapters from './en/chapters.md?raw';
import en_chat from './en/chat.md?raw';
import en_export from './en/export.md?raw';
import en_files from './en/files.md?raw';
import en_flow from './en/flow.md?raw';
import en_getting_started from './en/getting-started.md?raw';
import en_mcp from './en/mcp.md?raw';
import en_models_and_cache from './en/models-and-cache.md?raw';
import en_plugins from './en/plugins.md?raw';
import en_privacy from './en/privacy.md?raw';
import en_settings from './en/settings.md?raw';
import en_shortcuts from './en/shortcuts.md?raw';
import en_skills from './en/skills.md?raw';
import en_stats from './en/stats.md?raw';
import en_story_bible from './en/story-bible.md?raw';
import en_thinking from './en/thinking.md?raw';
import en_troubleshooting from './en/troubleshooting.md?raw';
import id_agent_md from './id/agent-md.md?raw';
import id_automations from './id/automations.md?raw';
import id_chapters from './id/chapters.md?raw';
import id_chat from './id/chat.md?raw';
import id_export from './id/export.md?raw';
import id_files from './id/files.md?raw';
import id_flow from './id/flow.md?raw';
import id_getting_started from './id/getting-started.md?raw';
import id_mcp from './id/mcp.md?raw';
import id_models_and_cache from './id/models-and-cache.md?raw';
import id_plugins from './id/plugins.md?raw';
import id_privacy from './id/privacy.md?raw';
import id_settings from './id/settings.md?raw';
import id_shortcuts from './id/shortcuts.md?raw';
import id_skills from './id/skills.md?raw';
import id_stats from './id/stats.md?raw';
import id_story_bible from './id/story-bible.md?raw';
import id_thinking from './id/thinking.md?raw';
import id_troubleshooting from './id/troubleshooting.md?raw';

const slugOf = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/.md$/, '');

function toDocs(mods: Record<string, string>): GuideDoc[] {
  return sortDocs(Object.entries(mods).map(([slug, raw]) => parseArticle(slugOf(slug), raw)));
}

/** Raw article text keyed by slug, per language. */
export const GUIDE_RAW: Record<GuideLang, Record<string, string>> = {
  en: {
    'agent-md': en_agent_md,
    'automations': en_automations,
    'chapters': en_chapters,
    'chat': en_chat,
    'export': en_export,
    'files': en_files,
    'flow': en_flow,
    'getting-started': en_getting_started,
    'mcp': en_mcp,
    'models-and-cache': en_models_and_cache,
    'plugins': en_plugins,
    'privacy': en_privacy,
    'settings': en_settings,
    'shortcuts': en_shortcuts,
    'skills': en_skills,
    'stats': en_stats,
    'story-bible': en_story_bible,
    'thinking': en_thinking,
    'troubleshooting': en_troubleshooting,
  },
  id: {
    'agent-md': id_agent_md,
    'automations': id_automations,
    'chapters': id_chapters,
    'chat': id_chat,
    'export': id_export,
    'files': id_files,
    'flow': id_flow,
    'getting-started': id_getting_started,
    'mcp': id_mcp,
    'models-and-cache': id_models_and_cache,
    'plugins': id_plugins,
    'privacy': id_privacy,
    'settings': id_settings,
    'shortcuts': id_shortcuts,
    'skills': id_skills,
    'stats': id_stats,
    'story-bible': id_story_bible,
    'thinking': id_thinking,
    'troubleshooting': id_troubleshooting,
  }
};

export const GUIDE_DOCS: Record<GuideLang, GuideDoc[]> = {
  en: toDocs(GUIDE_RAW.en),
  id: toDocs(GUIDE_RAW.id)
};

/** Slug of the article the guide opens on. */
export const DEFAULT_GUIDE_SLUG = 'getting-started';
