import { CSSProperties } from 'react';

/**
 * Pure-SVG icon set — no emoji, framework-consistent, inherits currentColor.
 * Each icon is a 16x16 viewBox stroked at 1.5px for optical consistency.
 */

export type IconName =
  | 'chat' | 'book' | 'settings' | 'folder' | 'folderPlus' | 'plus' | 'trash'
  | 'pencil' | 'chevronDown' | 'chevronRight' | 'chevronUp' | 'refresh' | 'download'
  | 'copy' | 'check' | 'x' | 'send' | 'stop' | 'brain' | 'tools' | 'memory'
  | 'user' | 'quill' | 'globe' | 'pin' | 'person' | 'sword' | 'scroll' | 'file'
  | 'plug' | 'bolt' | 'heart' | 'donate' | 'clock' | 'search' | 'cpu' | 'server'
  | 'tag' | 'logo' | 'target' | 'flame' | 'paperclip' | 'folderOpen' | 'sparkle'
  | 'github' | 'youtube' | 'linkedin' | 'twitter'
  | 'expand' | 'panelLeft';

const P = (d: string, key?: number) => <path key={key} d={d} />;

const ICONS: Record<IconName, JSX.Element> = {
  chat: P('M4 3h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 3v-3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'),
  book: (
    <>
      {P('M8 3C6.5 2 4 2 2.5 2.8V13c1.5-.8 4-.8 5.5.2 1.5-1 4-1 5.5-.2V2.8C12 2 9.5 2 8 3z', 0)}
      {P('M8 3v10.2', 1)}
    </>
  ),
  settings: (
    <>
      <circle key={0} cx="8" cy="8" r="2.2" />
      {P('M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4', 1)}
    </>
  ),
  folder: P('M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7z'),
  folderPlus: (
    <>
      {P('M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7z', 0)}
      {P('M8 7v4M6 9h4', 1)}
    </>
  ),
  plus: P('M8 3v10M3 8h10'),
  trash: (
    <>
      {P('M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8', 0)}
      {P('M6.8 7v3.5M9.2 7v3.5', 1)}
    </>
  ),
  pencil: P('M11.5 2.5a1.4 1.4 0 0 1 2 2L5 13l-2.6.6L3 11l8.5-8.5z'),
  chevronDown: P('M4 6.5L8 10.5l4-4'),
  chevronRight: P('M6.5 4L10.5 8l-4 4'),
  chevronUp: P('M4 9.5L8 5.5l4 4'),
  refresh: (
    <>
      {P('M13 8a5 5 0 1 1-1.5-3.6', 0)}
      {P('M13 2.5V5h-2.5', 1)}
    </>
  ),
  download: P('M8 2.5v7M5 7l3 3 3-3M3 12.5h10'),
  copy: (
    <>
      <rect key={0} x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      {P('M3.5 10.5v-7a1 1 0 0 1 1-1h6', 1)}
    </>
  ),
  check: P('M3 8.5l3.2 3.2L13 5'),
  x: P('M4 4l8 8M12 4l-8 8'),
  send: P('M13.5 2.5L2.5 7.2l4.3 1.9 1.9 4.4 4.8-11z'),
  stop: <rect key={0} x="4" y="4" width="8" height="8" rx="1" />,
  brain: (
    <>
      {P('M8 1.8a4.2 4.2 0 0 0-2.4 7.66c.36.26.6.68.6 1.14v.7h3.6v-.7c0-.46.24-.88.6-1.14A4.2 4.2 0 0 0 8 1.8z', 0)}
      {P('M6.5 13.5h3M7 15h2', 1)}
    </>
  ),
  tools: P('M3 13l6-6M11 2l3 3-2.5 2.5L8.5 4.5 11 2zM6.5 8.5L3 12'),
  memory: P('M4 4h8v8H4zM6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2'),
  user: (
    <>
      <circle key={0} cx="8" cy="5.5" r="2.5" />
      {P('M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4', 1)}
    </>
  ),
  quill: P('M13.5 2.5c-4 0-8 2-9.5 6.5L2.5 13.5l4.5-1.5c4.5-1.5 6.5-5.5 6.5-9.5zM4 12l4.5-4.5'),
  globe: (
    <>
      <circle key={0} cx="8" cy="8" r="5.5" />
      {P('M2.5 8h11M8 2.5c-3.5 3.5-3.5 7.5 0 11 3.5-3.5 3.5-7.5 0-11z', 1)}
    </>
  ),
  pin: P('M8 14s4-4.2 4-7.2A4 4 0 0 0 4 6.8c0 3 4 7.2 4 7.2zM8 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z'),
  person: (
    <>
      <circle key={0} cx="8" cy="5.5" r="2.5" />
      {P('M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4', 1)}
    </>
  ),
  sword: P('M13.5 2.5l-8 8M5.5 10.5l-2 2M4 9l3 3-1.5 1.5L3 12 4 9zM12 5l-1-1'),
  scroll: P('M4 3h8v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1zM6 6h4M6 9h4'),
  file: P('M4 2.5h5L12.5 6v7.5h-8.5zM9 2.5V6h3.5'),
  plug: P('M6 2.5v3M10 2.5v3M4.5 5.5h7v2a3.5 3.5 0 0 1-7 0v-2zM8 11v2.5'),
  bolt: P('M9 2L4 9.5h3.5L7 14l5-7.5H8.5L9 2z'),
  heart: P('M8 13.5S2.5 10 2.5 6.2A3.2 3.2 0 0 1 8 4a3.2 3.2 0 0 1 5.5 2.2C13.5 10 8 13.5 8 13.5z'),
  donate: P('M2.5 6.5h11v6h-11zM5.5 6.5V4a2.5 2.5 0 0 1 5 0v2.5M2.5 9h11'),
  clock: (
    <>
      <circle key={0} cx="8" cy="8" r="5.5" />
      {P('M8 5v3.2l2.2 1.3', 1)}
    </>
  ),
  search: (
    <>
      <circle key={0} cx="7" cy="7" r="4" />
      {P('M10.5 10.5l3 3', 1)}
    </>
  ),
  cpu: (
    <>
      <rect key={0} x="4.5" y="4.5" width="7" height="7" rx="1" />
      <rect key={1} x="6.5" y="6.5" width="3" height="3" />
      {P('M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M4 2.5l1 2M12 2.5l-1 2M4 13.5l1-2M12 13.5l-1-2', 2)}
    </>
  ),
  server: (
    <>
      <rect key={0} x="2.5" y="3" width="11" height="4.5" rx="1" />
      <rect key={1} x="2.5" y="8.5" width="11" height="4.5" rx="1" />
      {P('M5 5.2h.01M5 10.7h.01', 2)}
    </>
  ),
  tag: (
    <>
      {P('M2.5 7.6V3.5a1 1 0 0 1 1-1h4.1a1 1 0 0 1 .7.3l5 5a1 1 0 0 1 0 1.4l-4.1 4.1a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1-.3-.7z', 0)}
      <circle key={1} cx="5.8" cy="5.8" r="1" />
    </>
  ),
  target: (
    <>
      <circle key={0} cx="8" cy="8" r="5.5" />
      <circle key={1} cx="8" cy="8" r="2.6" />
      <circle key={2} cx="8" cy="8" r="0.4" />
    </>
  ),
  flame: (
    <>
      {P('M8 1.8c.6 2-0.8 3-1.6 4C5.5 7 4.5 8.2 4.5 10a3.5 3.5 0 0 0 7 0c0-1.2-.5-2.2-1.2-3-.2 1-.7 1.6-1.3 1.8.4-2.2-.3-5-1-7z', 0)}
    </>
  ),
  logo: <></>,
  paperclip: P('M10.8 4.2L5.6 9.4a2 2 0 0 0 2.8 2.8l5.2-5.2a3.5 3.5 0 0 0-5-5L3.5 7.2a5 5 0 0 0 7 7l4-4'),
  folderOpen: (
    <>
      {P('M2 12.5V4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V7', 0)}
      {P('M2 12.5l2-5h11l-2 5z', 1)}
    </>
  ),
  sparkle: (
    <>
      {P('M8 2l1.2 3.6L13 7l-3.8 1.4L8 12l-1.2-3.6L3 7l3.8-1.4z', 0)}
      {P('M12.8 10.6l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z', 1)}
    </>
  ),
  // Brand glyphs (filled, compact — drawn on the shared 16x16 grid)
  github: (
    <>
      <path key={0} d="M8 1.5a6.5 6.5 0 0 0-2.06 12.66c.33.06.45-.14.45-.31l-.01-1.1c-1.81.4-2.19-.87-2.19-.87-.3-.75-.72-.95-.72-.95-.59-.4.05-.4.05-.4.65.05 1 .67 1 .67.57 1 1.5.7 1.87.54.06-.42.22-.7.4-.86-1.44-.16-2.96-.72-2.96-3.22 0-.71.25-1.3.67-1.75-.07-.16-.29-.83.06-1.72 0 0 .54-.17 1.78.66a6.2 6.2 0 0 1 3.24 0c1.23-.83 1.77-.66 1.77-.66.36.9.14 1.56.07 1.72.42.45.67 1.04.67 1.75 0 2.5-1.52 3.05-2.97 3.21.23.2.44.6.44 1.2l-.01 1.78c0 .17.12.38.46.31A6.5 6.5 0 0 0 8 1.5z" fill="currentColor" stroke="none" />
    </>
  ),
  youtube: (
    <>
      <rect key={0} x="1.8" y="3.8" width="12.4" height="8.4" rx="2" fill="currentColor" stroke="none" />
      <path key={1} d="M7 6.2l3 1.8-3 1.8z" fill="var(--bg, #0b0d12)" stroke="none" />
    </>
  ),
  linkedin: (
    <>
      <rect key={0} x="2" y="6" width="2.6" height="8" fill="currentColor" stroke="none" />
      <circle key={1} cx="3.3" cy="3.4" r="1.4" fill="currentColor" stroke="none" />
      <path key={2} d="M6.6 6h2.5v1.2c.4-.7 1.3-1.4 2.6-1.4 2 0 3.3 1.3 3.3 3.8V14h-2.6v-4c0-1.2-.5-2-1.5-2s-1.7.8-1.7 2v4H6.6z" fill="currentColor" stroke="none" />
    </>
  ),
  twitter: (
    <>
      <path key={0} d="M2 2l4.9 6.4L2.3 14h1.9l3.6-4.3L11 14h3l-5.1-6.7L13.4 2h-1.9L8.2 5.9 5 2z" fill="currentColor" stroke="none" />
    </>
  ),
  expand: (
    <>
      {P('M2 6V3.5A1.5 1.5 0 0 1 3.5 2H6', 0)}
      {P('M10 2h2.5A1.5 1.5 0 0 1 14 3.5V6', 1)}
      {P('M14 10v2.5a1.5 1.5 0 0 1-1.5 1.5H10', 2)}
      {P('M6 14H3.5A1.5 1.5 0 0 1 2 12.5V10', 3)}
    </>
  ),
  panelLeft: (
    <>
      <rect key={0} x="2" y="2.5" width="12" height="11" rx="1.5" />
      {P('M6.5 2.5v11', 1)}
    </>
  )
};

// App mark: white rounded tile with bold black "OP" (OpenPlot monogram).
export function LogoMark({ size = 32, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      style={{ flexShrink: 0, display: 'block', ...style }}
      aria-hidden="true"
    >
      <rect width="48" height="48" rx="11" fill="#ffffff" />
      <rect width="48" height="48" rx="11" stroke="rgba(0,0,0,0.08)" strokeWidth="1" />
      <text
        x="24"
        y="24"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="'Segoe UI', system-ui, sans-serif"
        fontWeight="800"
        fontSize="19"
        letterSpacing="-0.5"
        fill="#000000"
      >OP</text>
    </svg>
  );
}

export function Icon({ name, size = 16, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  // Minimal usage note: pass `logo` anywhere the app mark is needed.
  if (name === 'logo') return <LogoMark size={size} style={style} />;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: '-2px', flexShrink: 0, ...style }}
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}
