import type { CustomAcpLaunchSpec } from './ai';

/**
 * Tokenizes a user-entered command line into a custom ACP launch spec.
 *
 * Supports POSIX-style quoting so paths/args with spaces work:
 * - double quotes: `"a b"` → `a b`, with `\"` and `\\` escapes
 * - single quotes: `'a b'` → `a b` (no escapes inside, like sh)
 * - backslash outside quotes escapes the next character
 *
 * This is intentionally NOT a shell: no variable expansion, globbing, pipes,
 * or redirection. The CLI spawns the command directly (no `sh -c`), so the
 * tokens here map 1:1 to argv. Returns null for an empty/whitespace-only line
 * or when a quote is left unclosed.
 */
export const parseCustomAcpCommandLine = (input: string): CustomAcpLaunchSpec | null => {
  const tokens: string[] = [];
  let current = '';
  let hasCurrent = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      // Inside double quotes a backslash only escapes `"` and `\` (POSIX); any
      // other backslash is literal. Outside quotes it escapes the next char.
      if (quote === '"' && char !== '"' && char !== '\\') {
        current += '\\';
      }
      current += char;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '\\') {
      escaped = true;
      hasCurrent = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasCurrent = true;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (hasCurrent || current.length > 0) {
        tokens.push(current);
        current = '';
        hasCurrent = false;
      }
      continue;
    }
    current += char;
    hasCurrent = true;
  }

  if (quote !== null || escaped) {
    return null;
  }
  if (hasCurrent || current.length > 0) {
    tokens.push(current);
  }

  const [command, ...args] = tokens;
  if (!command) {
    return null;
  }
  return { command, ...(args.length > 0 ? { args } : {}) };
};

const needsQuoting = (token: string): boolean => token.length === 0 || /[\s"'\\]/.test(token);

const quoteToken = (token: string): string => {
  if (!needsQuoting(token)) {
    return token;
  }
  return `"${token.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
};

/**
 * Renders a launch spec back into a single editable line. Round-trips through
 * {@link parseCustomAcpCommandLine}.
 */
export const formatCustomAcpCommandLine = (spec: CustomAcpLaunchSpec): string =>
  [spec.command, ...(spec.args ?? [])].map(quoteToken).join(' ');
