import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface PromptOptions {
  title: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  multiline?: boolean;
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
