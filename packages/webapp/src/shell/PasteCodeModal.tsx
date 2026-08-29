import { useEffect, useRef, useState } from 'react';
import { terminalPastePayload } from '../terminal-paste';

/** The statusline's "Paste code" prompt: one line of text, delivered to the
 * terminal as a paste rather than typed keystrokes. */
export function PasteCodeModal({
  onCancel,
  onSend,
}: {
  onCancel: () => void;
  onSend: (payload: { data: string; enters: number }) => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const canSend = text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    // Paste-code submits the raw text; the terminal layer then sends Enter
    // twice, each gated on the pty responding (echo, then the next screen) —
    // bundling \r with the text makes Claude's input treat it as pasted
    // content and swallow the submit.
    onSend({ data: terminalPastePayload(text.trim(), false), enters: 2 });
  };

  return (
    <div className="terminal-prompt-scrim" role="presentation" onClick={onCancel}>
      <div
        className="terminal-prompt-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Paste code"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="terminal-prompt-modal__title">Paste code</p>
        <input
          ref={inputRef}
          className="terminal-prompt-modal__input"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Paste the code here"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') send();
          }}
        />
        <div className="terminal-prompt-modal__actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" disabled={!canSend} onClick={send}>Send</button>
        </div>
      </div>
    </div>
  );
}
