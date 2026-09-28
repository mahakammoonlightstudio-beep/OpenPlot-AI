/**
 * Curated provider/model presets — a starting catalog so users don't have to
 * know base URLs by heart. Model ids reflect the 2025/2026 generation lineups;
 * providers rotate ids over time, "Fetch models" always refreshes the live list.
 */

export interface PresetModel {
  id: string;
  note?: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  kind: 'openai' | 'anthropic' | 'auto';
  needsKey: boolean;
  models: PresetModel[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    kind: 'openai',
    needsKey: true,
    models: [
      { id: 'gpt-5.2', note: 'flagship' },
      { id: 'gpt-5.2-mini', note: 'fast & cheap' },
      { id: 'gpt-5.2-nano', note: 'cheapest' },
      { id: 'gpt-4.1-mini' },
      { id: 'o4-mini', note: 'reasoning' }
    ]
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    kind: 'anthropic',
    needsKey: true,
    models: [
      { id: 'claude-opus-4-5', note: 'flagship' },
      { id: 'claude-sonnet-4-5', note: 'balanced' },
      { id: 'claude-haiku-4-5', note: 'fast & cheap' }
    ]
  },
  {
    id: 'google',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    kind: 'openai',
    needsKey: true,
    models: [
      { id: 'gemini-3-pro', note: 'flagship' },
      { id: 'gemini-3-flash', note: 'fast & cheap' },
      { id: 'gemini-2.5-flash-lite' }
    ]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    kind: 'openai',
    needsKey: true,
    models: [
      { id: 'deepseek-chat', note: 'V3.x' },
      { id: 'deepseek-reasoner', note: 'R-series reasoning' }
    ]
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    kind: 'openai',
    needsKey: true,
    models: [
      { id: 'grok-4', note: 'flagship' },
      { id: 'grok-4-fast', note: 'fast & cheap' }
    ]
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    kind: 'openai',
    needsKey: true,
    models: [
      { id: 'kimi-k2-0905-preview', note: 'K2 latest' },
      { id: 'kimi-k2-turbo-preview', note: 'fast' }
    ]
  },
  {
    id: 'zai',
    name: 'Z.ai GLM',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    kind: 'openai',
    needsKey: true,
    models: [
      { id: 'glm-4.6', note: 'flagship' },
      { id: 'glm-4.5-air', note: 'fast & cheap' }
    ]
  },
  {
    id: 'qwen',
    name: 'Alibaba Qwen',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    kind: 'openai',
    needsKey: true,
    models: [
      { id: 'qwen3-max', note: 'flagship' },
      { id: 'qwen3-coder-plus' },
      { id: 'qwen3-235b-a22b-instruct' }
    ]
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    kind: 'openai',
    needsKey: true,
    models: [
      { id: 'mistral-large-latest', note: 'flagship' },
      { id: 'mistral-small-latest', note: 'cheap' },
      { id: 'codestral-latest', note: 'code' }
    ]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (multi-provider)',
    baseUrl: 'https://openrouter.ai/api/v1',
    kind: 'openai',
    needsKey: true,
    models: [
      { id: 'openai/gpt-5.2-mini' },
      { id: 'anthropic/claude-sonnet-4.5' },
      { id: 'google/gemini-3-flash' },
      { id: 'deepseek/deepseek-chat' },
      { id: 'meta-llama/llama-4-maverick', note: 'open weights' }
    ]
  },
  {
    id: 'groq',
    name: 'Groq (fast inference)',
    baseUrl: 'https://api.groq.com/openai/v1',
    kind: 'openai',
    needsKey: true,
    models: [
      { id: 'llama-3.3-70b-versatile' },
      { id: 'openai/gpt-oss-120b', note: 'open weights' }
    ]
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    kind: 'openai',
    needsKey: false,
    models: [
      { id: 'llama3.2', note: 'install via ollama pull' },
      { id: 'qwen3:8b' },
      { id: 'gemma3' }
    ]
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    kind: 'openai',
    needsKey: false,
    models: [{ id: 'local-model', note: 'load a model in LM Studio' }]
  }
];

// ---------- live preset refresh ----------

import { fetchModels, ProviderConfig } from './ai';

export interface PresetRefreshResult {
  presetId: string;
  presetName: string;
  ok: boolean;
  modelCount: number;
  error?: string;
}

/**
 * Refreshes presets for providers the user actually has configured: for every
 * existing provider that matches a preset's base URL, re-fetches the live
 * model list and merges it into the preset catalog. Returns a per-preset report.
 */
export async function refreshPresets(existingProviders: ProviderConfig[]): Promise<PresetRefreshResult[]> {
  const results: PresetRefreshResult[] = [];
  for (const preset of PROVIDER_PRESETS) {
    if (!preset.needsKey) continue; // local presets: nothing to refresh remotely
    const configured = existingProviders.find((p) => {
      try {
        const a = new URL((p.baseUrl || '').includes('://') ? p.baseUrl : `https://${p.baseUrl}`).host;
        const b = new URL(preset.baseUrl).host;
        return a === b;
      } catch {
        return false;
      }
    });
    if (!configured) {
      results.push({ presetId: preset.id, presetName: preset.name, ok: true, modelCount: preset.models.length });
      continue;
    }
    try {
      const models = await fetchModels(configured);
      if (models.length) {
        // merge live ids (fresh first) while preserving preset notes
        const notes = new Map(preset.models.map((m) => [m.id, m.note]));
        preset.models = models.map((id) => ({ id, note: notes.get(id) }));
      }
      results.push({ presetId: preset.id, presetName: preset.name, ok: true, modelCount: preset.models.length });
    } catch (err: any) {
      results.push({
        presetId: preset.id, presetName: preset.name, ok: false,
        modelCount: preset.models.length, error: err?.message || String(err)
      });
    }
  }
  return results;
}
