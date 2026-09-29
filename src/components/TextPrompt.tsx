import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface PromptOptions {
  title: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  multiline?: boolean;
}

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/**
 * BUG FIX: Electron's window.confirm() steals keyboard focus from the
 * webContents and never gives it back — after closing the native dialog the
 * whole app randomly stopped accepting keystrokes until the user clicked
 * outside and back into the window. Every in-app confirm now goes through
 * confirmDialog() instead, which is plain DOM and never touches native focus.
 *
 * As a belt-and-braces measure, after any dialog host unmounts we refocus the
 * app root so focus can never be left on a removed element.
 */
function restoreFocusAfterDialog(): void {
  requestAnimationFrame(() => {
    const root = document.getElementById('app-root');
    if (!root || !document.contains(root)) return;
    const ae = document.activeElement;
    // Only rescue focus when it truly fell off (body or a removed element).
    // If another dialog already took focus, leave it alone.
    if (ae === document.body || (ae && !document.contains(ae))) {
      root.focus();
    }
  });
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'modal-host';
    document.body.appendChild(host);
    const root = createRoot(host);

    const cleanup = (result: boolean) => {
      root.unmount();
      host.remove();
      restoreFocusAfterDialog();
      resolve(result);
    };

    function ConfirmModal() {
      const okRef = useRef<HTMLButtonElement>(null);
      useEffect(() => {
        const t = setTimeout(() => okRef.current?.focus(), 30);
        return () => clearTimeout(t);
      }, []);
      const onKey = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
        else if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      };
      return (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) cleanup(false); }}>
          <div className="modal" role="alertdialog" aria-modal="true" aria-label={opts.title} onKeyDown={onKey}>
            <h2>{opts.title}</h2>
            {opts.message && <p className="confirm-message">{opts.message}</p>}
            <div className="foot">
              <button onClick={() => cleanup(false)}>{opts.cancelLabel || 'Cancel'}</button>
              <button ref={okRef} className={opts.danger ? 'danger' : 'primary'} onClick={() => cleanup(true)}>
                {opts.confirmLabel || 'OK'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    root.render(<ConfirmModal />);
  });
}

/**
 * Promise-based text input dialog.
 * Electron does not support window.prompt()/confirm() for input, so all
 * name-entry flows go through this modal.
 */
export function textPrompt(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'modal-host';
    document.body.appendChild(host);
    const root = createRoot(host);

    const cleanup = (result: string | null) => {
      root.unmount();
      host.remove();
      restoreFocusAfterDialog();
      resolve(result);
    };

    function PromptModal() {
      const [val, setVal] = useState(opts.defaultValue || '');
      const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
      useEffect(() => {
        setTimeout(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        }, 30);
      }, []);
      const submit = () => {
        const v = val.trim();
        cleanup(v || null);
      };
      const onKey = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && (opts.multiline ? e.ctrlKey : !e.shiftKey)) {
          e.preventDefault();
          submit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cleanup(null);
        }
      };
      return (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) cleanup(null); }}>
          <div className="modal" role="dialog" aria-label={opts.title}>
            <h2>{opts.title}</h2>
            {opts.multiline ? (
              <textarea
                ref={(el) => { inputRef.current = el; }}
                rows={5}
                value={val}
                placeholder={opts.placeholder || ''}
                onChange={(e) => setVal(e.target.value)}
                onKeyDown={onKey}
              />
            ) : (
              <input
                ref={(el) => { inputRef.current = el; }}
                value={val}
                placeholder={opts.placeholder || ''}
                onChange={(e) => setVal(e.target.value)}
                onKeyDown={onKey}
              />
            )}
            <div className="foot">
              <button onClick={() => cleanup(null)}>Cancel</button>
              <button className="primary" onClick={submit}>{opts.confirmLabel || 'OK'}</button>
            </div>
          </div>
        </div>
      );
    }

    root.render(<PromptModal />);
  });
}
