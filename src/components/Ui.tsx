import { useEffect, useRef, useState, ReactNode } from 'react';
import { Icon, IconName } from './Icons';

/**
 * Reusable overlay primitives — ONE implementation of outside-click +
 * Escape handling shared by every dropdown in the app (was duplicated in
 * several places before). Close-on-scroll is opt-in via `closeOnScroll`.
 */

/** Tiny anchored dropdown menu. Auto-flips upward when near the viewport bottom. */
export function Popover({
  open,
  onClose,
  children,
  align = 'left',
  width,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: 'left' | 'right';
  width?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Flip decision is made once per open — measuring on every render would
  // cause layout thrash and visible jitter while the menu is visible.
  const [dropUp, setDropUp] = useState(false);
  useEffect(() => {
    if (!open) return;
    const anchor = ref.current?.parentElement;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    // Open upward only when there isn't enough room below AND above is bigger.
    setDropUp(spaceBelow < 240 && spaceAbove > spaceBelow);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      // Clicks on the anchor button itself are ignored so its onClick toggle
      // stays in charge — otherwise mousedown closes and click reopens.
      const anchor = ref.current.parentElement;
      if (anchor && anchor.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    // capture:true — catch Escape before other global handlers
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      className={`ui-popover ${align === 'right' ? 'align-right' : ''} ${dropUp ? 'drop-up' : ''}`}
      style={width ? { width } : undefined}
    >
      {children}
    </div>
  );
}

/** Menu item row for Popover content. */
export function MenuItem({
  icon,
  label,
  desc,
  active,
  danger,
  onClick,
}: {
  icon?: IconName;
  label: string;
  desc?: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`ui-menu-item ${active ? 'active' : ''} ${danger ? 'danger' : ''}`} onClick={onClick}>
      {icon && <Icon name={icon} size={14} />}
      <span className="ui-menu-label">{label}</span>
      {desc && <span className="ui-menu-desc">{desc}</span>}
      {active && <Icon name="check" size={13} />}
    </button>
 );
}

/** iOS-style switch. */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`ui-switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

/** Centered modal with backdrop (Escape + backdrop click to close). */
export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 560,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab') {
        // Basic focus trap: keep Tab cycling inside the dialog.
        const root = document.querySelector('.ui-modal-card');
        if (!root) return;
        const focusables = root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="ui-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ui-modal-card" style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="ui-modal-head">
          <h3>{title}</h3>
          <button className="small ghost" onClick={onClose} aria-label="Close"><Icon name="x" size={15} /></button>
        </div>
        <div className="ui-modal-body">{children}</div>
        {footer && <div className="ui-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
