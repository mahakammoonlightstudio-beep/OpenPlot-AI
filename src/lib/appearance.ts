import type { CSSProperties } from 'react';

export type UiFontChoice = 'system' | 'serif' | 'rounded' | 'mono' | 'custom';

/** The default theme follows the OS; explicit choices always win. */
export const SYSTEM_THEME = 'system';
export const LIGHT_THEME = 'light-paper';
export const DARK_THEME = 'dark-classic';

export function resolveTheme(theme: string, prefersDark: boolean): string {
  if (theme !== SYSTEM_THEME) return theme || SYSTEM_THEME;
  return prefersDark ? DARK_THEME : LIGHT_THEME;
}

/**
 * Named stacks keep the appearance picker useful without allowing arbitrary
 * CSS into the document. "Custom" is still a font-family list, never a rule.
 */
export const UI_FONTS: Array<{ id: UiFontChoice; labelKey: string; preview: string }> = [
  { id: 'system', labelKey: 'appearance.font.system', preview: 'Segoe UI / system-ui' },
  { id: 'serif', labelKey: 'appearance.font.serif', preview: 'Georgia / serif' },
  { id: 'rounded', labelKey: 'appearance.font.rounded', preview: 'Nunito / rounded' },
  { id: 'mono', labelKey: 'appearance.font.mono', preview: 'Cascadia / monospace' },
  { id: 'custom', labelKey: 'appearance.font.custom', preview: 'Your own font stack' }
];

const STACKS: Record<Exclude<UiFontChoice, 'custom'>, string> = {
  system: "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif",
  rounded: "'Segoe UI Variable', 'Nunito', 'Varela Round', 'Trebuchet MS', system-ui, sans-serif",
  mono: "'Cascadia Code', 'JetBrains Mono', Consolas, 'Courier New', monospace"
};

/** A custom family may contain punctuation (quotes, commas) but never a rule. */
export function sanitizeFontFamily(value: string): string {
  return String(value || '').replace(/[;{}<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

export function uiFontStack(choice: UiFontChoice, custom: string): string {
  if (choice === 'custom') {
    const safe = sanitizeFontFamily(custom);
    return safe ? `${safe}, system-ui, sans-serif` : STACKS.system;
  }
  return STACKS[choice] || STACKS.system;
}

/** Shared CSS variables for the appearance preview chips and the real app. */
export function appearanceVars(font: string, radius: number): CSSProperties {
  return {
    '--font': font,
    '--radius': `${radius}px`
  } as CSSProperties;
}
