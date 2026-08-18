import { diffLines } from 'diff';

export type LineDiff = {
  type: 'removed' | 'added' | 'context';
  text: string;
};

const namedEntities = new Map([
  ['amp', '&'],
  ['apos', '\''],
  ['gt', '>'],
  ['lt', '<'],
  ['nbsp', '\u00a0'],
  ['quot', '"'],
]);

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/giu, (entity, body: string) => {
    if (body[0] !== '#') return namedEntities.get(body.toLowerCase()) ?? entity;
    const hexadecimal = body[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isFinite(codePoint) || codePoint > 0x10ffff) return entity;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return entity;
    }
  });
}

export function normalizeInlineCodeFences(value: string): string {
  return value.replace(/```([^\r\n]*?)```/gu, (_match, content: string) => `\`${content}\``);
}

function unescapeText(value: string): string {
  return value.replace(/\\([ntr])/gu, (_match, escaped: string) => {
    if (escaped === 'n') return '\n';
    if (escaped === 't') return '\t';
    return '\r';
  });
}

export function unescapeWithMathProtection(value: string): string {
  let cursor = 0;
  let output = '';

  while (cursor < value.length) {
    const opening = value.indexOf('$', cursor);
    if (opening < 0) return output + unescapeText(value.slice(cursor));

    const delimiter = value.startsWith('$$', opening) ? '$$' : '$';
    const closing = value.indexOf(delimiter, opening + delimiter.length);
    if (closing < 0) return output + unescapeText(value.slice(cursor));

    output += unescapeText(value.slice(cursor, opening));
    output += value.slice(opening, closing + delimiter.length);
    cursor = closing + delimiter.length;
  }

  return output;
}

function timezoneLabel(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `GMT${sign}${hours}${minutes === 0 ? '' : `:${String(minutes).padStart(2, '0')}`}`;
}

function timezoneCity(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone) return 'Local time';
  return (zone.split('/').pop() ?? zone).replaceAll('_', ' ');
}

export function formatUsageLimitText(value: string): string {
  const match = /^Claude AI usage limit reached\|(\d+)$/u.exec(value.trim());
  if (!match) return value;

  const rawTimestamp = Number(match[1]);
  const date = new Date(rawTimestamp < 1_000_000_000_000 ? rawTimestamp * 1_000 : rawTimestamp);
  if (Number.isNaN(date.getTime())) return value;

  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const month = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date);
  return `Your limit will reset at **${time} ${timezoneLabel(date)} (${timezoneCity()})**`
    + ` - ${date.getDate()} ${month} ${date.getFullYear()}`;
}

export function basename(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.at(-1) ?? '';
}

// Real multi-hunk line diff (jsdiff LCS) — separated edits stay separate hunks
// with untouched context between them instead of one merged removed/added region.
export function buildLineDiff(oldStr: string, newStr: string): LineDiff[] {
  if (oldStr === newStr) return [];
  return diffLines(oldStr, newStr).flatMap((part) => {
    const type: LineDiff['type'] = part.added ? 'added' : part.removed ? 'removed' : 'context';
    const partLines = part.value.split('\n');
    if (partLines.at(-1) === '') partLines.pop();
    return partLines.map((text): LineDiff => ({ type, text }));
  });
}
