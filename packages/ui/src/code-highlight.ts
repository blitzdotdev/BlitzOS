import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';

// House CodeMirror syntax palette, shared by the file editor and chat code views.
export const codeSyntaxHighlighting: Extension = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword], color: 'var(--ansi-magenta)' },
  { tag: [tags.name, tags.variableName, tags.propertyName], color: 'var(--ink)' },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.className], color: 'var(--ansi-blue)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--ansi-green)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--ansi-yellow)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--faint)', fontStyle: 'italic' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--ansi-cyan)' },
  { tag: [tags.invalid], color: 'var(--ansi-red)' },
]));
