import type { LineRange } from './types';

const RANGE_CONTEXT_LINES = 3;

export function createSparseTextForRanges(
  text: string,
  ranges: readonly LineRange[],
  contextLines = RANGE_CONTEXT_LINES
): string {
  if (ranges.length === 0) {
    return text;
  }
  const lines = splitSourceLines(text);
  const keep = new Set<number>();
  for (const range of ranges) {
    const start = Math.max(1, range.start - contextLines);
    const end = Math.min(lines.length, range.end + contextLines);
    for (let line = start; line <= end; line += 1) {
      keep.add(line);
    }
  }
  return lines.map((line, index) => (keep.has(index + 1) ? line : '')).join('\n');
}

export function getSourceLine(text: string, lineNumber: number): string | undefined {
  if (lineNumber <= 0) {
    return undefined;
  }
  return splitSourceLines(text)[lineNumber - 1];
}

function splitSourceLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
}
