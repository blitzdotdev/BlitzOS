import { useEffect, useState } from 'react';
import { LanguageDescription } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { languages } from '@codemirror/language-data';
import CodeMirror from '@uiw/react-codemirror';
import { codeSyntaxHighlighting } from './code-highlight';

const chatCodeTheme: Extension = [
  EditorView.theme({
    '&': {
      backgroundColor: 'transparent',
      color: 'var(--ink)',
      fontSize: '11.5px',
      maxHeight: '320px',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.6',
    },
    '.cm-content': { padding: '0' },
  }, { dark: true }),
  codeSyntaxHighlighting,
  EditorView.lineWrapping,
];

// Read-only CodeMirror view for chat payloads, matched by filename extension
// or explicit language name (same language-data set as the file editor).
export function CodeView({
  text,
  filename,
  language,
}: {
  text: string;
  filename?: string;
  language?: string;
}) {
  const [support, setSupport] = useState<Extension | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSupport(null);
    const description = (filename
      ? LanguageDescription.matchFilename(languages, filename)
      : null)
      ?? (language ? LanguageDescription.matchLanguageName(languages, language) : null);
    if (!description) return;
    void description.load().then((loaded) => {
      if (!cancelled) setSupport(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [filename, language]);

  return (
    <div className="chat-code-view">
      <CodeMirror
        value={text}
        editable={false}
        theme={chatCodeTheme}
        extensions={support ? [support] : []}
        basicSetup={false}
      />
    </div>
  );
}
