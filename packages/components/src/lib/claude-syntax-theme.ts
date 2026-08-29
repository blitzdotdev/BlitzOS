/**
 * Claude-themed syntax highlighting theme
 * Features orange, purple, and violet colors to match Claude's aesthetic
 */
export const claudeSyntaxTheme: Record<string, Record<string, string | number>> = {
  'code[class*="language-"]': {
    color: 'hsl(var(--code-foreground))',
    background: 'transparent',
    textShadow: 'none',
    fontFamily: 'var(--font-mono)',
    fontSize: 'inherit',
    textAlign: 'left',
    whiteSpace: 'pre',
    wordSpacing: 'normal',
    wordBreak: 'normal',
    wordWrap: 'normal',
    lineHeight: '1.5',
    MozTabSize: '4',
    OTabSize: '4',
    tabSize: '4',
    WebkitHyphens: 'none',
    MozHyphens: 'none',
    msHyphens: 'none',
    hyphens: 'none',
  },
  'pre[class*="language-"]': {
    color: 'hsl(var(--code-foreground))',
    background: 'transparent',
    textShadow: 'none',
    fontFamily: 'var(--font-mono)',
    fontSize: 'inherit',
    textAlign: 'left',
    whiteSpace: 'pre',
    wordSpacing: 'normal',
    wordBreak: 'normal',
    wordWrap: 'normal',
    lineHeight: '1.5',
    MozTabSize: '4',
    OTabSize: '4',
    tabSize: '4',
    WebkitHyphens: 'none',
    MozHyphens: 'none',
    msHyphens: 'none',
    hyphens: 'none',
    padding: '0',
    margin: '0',
    overflow: 'visible',
  },
  ':not(pre) > code[class*="language-"]': {
    background: 'transparent',
    padding: '0',
    borderRadius: '0',
    whiteSpace: 'normal',
  },
  comment: {
    color: 'hsl(var(--syntax-comment))',
    fontStyle: 'italic',
  },
  prolog: {
    color: 'hsl(var(--syntax-comment))',
  },
  doctype: {
    color: 'hsl(var(--syntax-comment))',
  },
  cdata: {
    color: 'hsl(var(--syntax-comment))',
  },
  punctuation: {
    color: 'hsl(var(--code-foreground))',
  },
  namespace: {
    opacity: '0.7',
  },
  property: {
    color: 'hsl(var(--syntax-attr))',
  },
  tag: {
    color: 'hsl(var(--syntax-keyword))',
  },
  boolean: {
    color: 'hsl(var(--syntax-number))',
  },
  number: {
    color: 'hsl(var(--syntax-number))',
  },
  constant: {
    color: 'hsl(var(--syntax-number))',
  },
  symbol: {
    color: 'hsl(var(--syntax-number))',
  },
  deleted: {
    color: '#ef4444',
  },
  selector: {
    color: 'hsl(var(--syntax-title))',
  },
  'attr-name': {
    color: 'hsl(var(--syntax-attr))',
  },
  string: {
    color: 'hsl(var(--syntax-string))',
  },
  char: {
    color: 'hsl(var(--syntax-string))',
  },
  builtin: {
    color: 'hsl(var(--syntax-builtin))',
  },
  url: {
    color: 'hsl(var(--syntax-string))',
  },
  inserted: {
    color: 'hsl(var(--syntax-string))',
  },
  entity: {
    color: 'hsl(var(--syntax-variable))',
    cursor: 'help',
  },
  atrule: {
    color: 'hsl(var(--syntax-keyword))',
  },
  'attr-value': {
    color: 'hsl(var(--syntax-string))',
  },
  keyword: {
    color: 'hsl(var(--syntax-keyword))',
  },
  function: {
    color: 'hsl(var(--syntax-function))',
  },
  'class-name': {
    color: 'hsl(var(--syntax-title))',
  },
  regex: {
    color: 'hsl(var(--syntax-string))',
  },
  important: {
    color: 'hsl(var(--syntax-number))',
    fontWeight: 'bold',
  },
  variable: {
    color: 'hsl(var(--syntax-variable))',
  },
  bold: {
    fontWeight: 'bold',
  },
  italic: {
    fontStyle: 'italic',
  },
  operator: {
    color: 'hsl(var(--code-foreground))',
  },
  script: {
    color: 'hsl(var(--code-foreground))',
  },
  parameter: {
    color: 'hsl(var(--syntax-variable))',
  },
  method: {
    color: 'hsl(var(--syntax-function))',
  },
  field: {
    color: 'hsl(var(--syntax-attr))',
  },
  annotation: {
    color: 'hsl(var(--syntax-comment))',
  },
  type: {
    color: 'hsl(var(--syntax-title))',
  },
  module: {
    color: 'hsl(var(--syntax-builtin))',
  },
};
