const encoder = new TextEncoder();

export const TERMINAL_PREVIEW_MAX_BYTES = 32 * 1024;
export const TERMINAL_PREVIEW_MAX_LINES = 16;
export const TERMINAL_PREVIEW_MAX_LINE_BYTES = 4 * 1024;

export type TerminalPreview = {
  text: string;
  wasLimited: boolean;
  omittedLongLine: boolean;
};

type TerminalPreviewOptions = {
  maxBytes?: number;
  maxLines?: number;
  maxLineBytes?: number;
};

const byteLength = (value: string) => encoder.encode(value).byteLength;

const countLines = (value: string): number => {
  let lines = value.length > 0 ? 1 : 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
};

/**
 * Makes the only string passed to ANSI parsing/React bounded.  It deliberately
 * scans from the end and never splits the complete legacy output into lines.
 */
export const prepareTerminalPreview = (
  value: string,
  {
    maxBytes = TERMINAL_PREVIEW_MAX_BYTES,
    maxLines = TERMINAL_PREVIEW_MAX_LINES,
    maxLineBytes = TERMINAL_PREVIEW_MAX_LINE_BYTES,
  }: TerminalPreviewOptions = {}
): TerminalPreview => {
  if (!value || maxBytes <= 0 || maxLines <= 0) {
    return { text: '', wasLimited: value.length > 0, omittedLongLine: false };
  }

  const parts: string[] = [];
  let cursor = value.length;
  let usedBytes = 0;
  let lines = 0;
  let wasLimited = false;
  let omittedLongLine = false;

  while (cursor > 0 && lines < maxLines && usedBytes < maxBytes) {
    // Probe only one permitted line. If no newline appears here, finding the
    // true beginning would turn a 1 MiB legacy line into a main-thread scan.
    const probeStart = Math.max(0, cursor - maxLineBytes - 1);
    const probe = value.slice(probeStart, cursor);
    const newline = probe.lastIndexOf('\n');

    if (newline === -1 && probeStart > 0) {
      const marker = `[A terminal line of at least ${probe.length} characters was omitted]`;
      if (usedBytes + byteLength(marker) <= maxBytes) parts.unshift(marker);
      return { text: parts.join('\n'), wasLimited: true, omittedLongLine: true };
    }

    const lineStart = newline === -1 ? 0 : probeStart + newline + 1;
    const line = value.slice(lineStart, cursor);
    const lineBytes = byteLength(line);
    if (lineBytes > maxLineBytes) {
      const marker = `[A terminal line of ${line.length} characters was omitted]`;
      if (usedBytes + byteLength(marker) <= maxBytes) {
        parts.unshift(marker);
        usedBytes += byteLength(marker);
      }
      omittedLongLine = true;
    } else if (usedBytes + lineBytes <= maxBytes) {
      parts.unshift(line);
      usedBytes += lineBytes;
      lines += 1;
    } else {
      wasLimited = true;
      break;
    }

    cursor = newline === -1 ? 0 : lineStart - 1;
  }

  wasLimited ||= cursor > 0 || lines >= maxLines;
  return { text: parts.join('\n'), wasLimited, omittedLongLine };
};

type TerminalOutputBlockLike = { output?: string };

type CachedBlocksPreview = {
  blocks: readonly TerminalOutputBlockLike[];
  preview: TerminalPreview;
};

// Callers run in render bodies that execute on every streaming delta, but the
// block objects are identity-stable for unchanged history items (loro-mirror
// structural sharing). Keyed on the tail block — the only one that grows while
// a command streams — so settled terminals cost a few ref compares instead of
// a 32 KiB scan + re-encode per render.
const blocksPreviewCache = new WeakMap<TerminalOutputBlockLike, CachedBlocksPreview>();

const computeTerminalOutputBlocksPreview = (
  blocks: readonly TerminalOutputBlockLike[]
): TerminalPreview => {
  const parts: string[] = [];
  let usedBytes = 0;
  let lines = 0;
  let wasLimited = false;
  let omittedLongLine = false;

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const output = blocks[index]?.output;
    if (!output || usedBytes >= TERMINAL_PREVIEW_MAX_BYTES || lines >= TERMINAL_PREVIEW_MAX_LINES) {
      wasLimited ||= Boolean(output);
      continue;
    }
    const separatorBytes = parts.length > 0 ? 1 : 0;
    const preview = prepareTerminalPreview(output, {
      maxBytes: TERMINAL_PREVIEW_MAX_BYTES - usedBytes - separatorBytes,
      maxLines: TERMINAL_PREVIEW_MAX_LINES - lines,
    });
    if (preview.text) {
      parts.unshift(preview.text);
      usedBytes += separatorBytes + byteLength(preview.text);
      lines += countLines(preview.text);
    }
    wasLimited ||= preview.wasLimited;
    omittedLongLine ||= preview.omittedLongLine;
  }

  return { text: parts.join('\n'), wasLimited, omittedLongLine };
};

/** Collect legacy adjacent blocks from the tail without constructing their full join. */
export const prepareTerminalOutputBlocksPreview = (
  blocks: readonly TerminalOutputBlockLike[]
): TerminalPreview => {
  const cacheKey = blocks[blocks.length - 1];
  if (cacheKey !== undefined) {
    const cached = blocksPreviewCache.get(cacheKey);
    if (
      cached &&
      cached.blocks.length === blocks.length &&
      cached.blocks.every((block, index) => block === blocks[index])
    ) {
      return cached.preview;
    }
  }
  const preview = computeTerminalOutputBlocksPreview(blocks);
  if (cacheKey !== undefined) {
    blocksPreviewCache.set(cacheKey, { blocks: blocks.slice(), preview });
  }
  return preview;
};
