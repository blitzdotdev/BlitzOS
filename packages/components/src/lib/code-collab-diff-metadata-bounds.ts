import type { FileDiffMetadata } from '@pierre/diffs';

export const DEFAULT_CODE_COLLAB_FRONTIER_DIFF_MAX_PARSED_CHANGED_LINES = 20_000;
export const DEFAULT_CODE_COLLAB_FRONTIER_DIFF_MAX_PARSED_HUNK_LINES = 40_000;
export const DEFAULT_CODE_COLLAB_FRONTIER_DIFF_MAX_PARSED_HUNK_TEXT_LENGTH = 1024 * 1024;

export type CodeCollabFrontierDiffTooLargeReason =
  | 'source-text-too-large'
  | 'parsed-changed-lines-too-large'
  | 'parsed-hunk-lines-too-large'
  | 'parsed-hunk-text-too-large';

type ParsedFileDiffComplexity = {
  readonly hunkCount: number;
  readonly changedLines: number;
  readonly hunkLines: number;
  readonly hunkTextLength: number;
};

type ParsedFileDiffBounds = {
  readonly maxChangedLines?: number;
  readonly maxHunkLines?: number;
  readonly maxHunkTextLength?: number;
};

type BoundedParsedFileDiffResult =
  | {
      readonly status: 'ready';
      readonly fileDiff: FileDiffMetadata;
      readonly complexity: ParsedFileDiffComplexity;
    }
  | {
      readonly status: 'too-large';
      readonly reason: CodeCollabFrontierDiffTooLargeReason;
      readonly complexity: ParsedFileDiffComplexity;
    };

export function boundParsedFileDiffForMainThread(
  fileDiff: FileDiffMetadata,
  bounds: ParsedFileDiffBounds = {}
): BoundedParsedFileDiffResult {
  const complexity = measureParsedFileDiffComplexity(fileDiff);
  if (bounds.maxChangedLines !== undefined && complexity.changedLines > bounds.maxChangedLines) {
    return {
      status: 'too-large',
      reason: 'parsed-changed-lines-too-large',
      complexity,
    };
  }
  if (bounds.maxHunkLines !== undefined && complexity.hunkLines > bounds.maxHunkLines) {
    return {
      status: 'too-large',
      reason: 'parsed-hunk-lines-too-large',
      complexity,
    };
  }
  if (
    bounds.maxHunkTextLength !== undefined &&
    complexity.hunkTextLength > bounds.maxHunkTextLength
  ) {
    return {
      status: 'too-large',
      reason: 'parsed-hunk-text-too-large',
      complexity,
    };
  }
  return {
    status: 'ready',
    fileDiff: stripParsedFileDiffFullText(fileDiff),
    complexity,
  };
}

export function stripParsedFileDiffFullText(fileDiff: FileDiffMetadata): FileDiffMetadata {
  const stripped: FileDiffMetadata = { ...fileDiff };
  delete stripped.oldLines;
  delete stripped.newLines;
  return stripped;
}

export function measureParsedFileDiffComplexity(
  fileDiff: FileDiffMetadata
): ParsedFileDiffComplexity {
  let changedLines = 0;
  let hunkLines = 0;
  let hunkTextLength = 0;

  for (const hunk of fileDiff.hunks) {
    changedLines += Math.max(hunk.additionLines, hunk.deletionLines);
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        hunkLines += content.lines.length;
        hunkTextLength += countLinesTextLength(content.lines);
      } else {
        hunkLines += content.additions.length + content.deletions.length;
        hunkTextLength +=
          countLinesTextLength(content.additions) + countLinesTextLength(content.deletions);
      }
    }
  }

  return {
    hunkCount: fileDiff.hunks.length,
    changedLines,
    hunkLines,
    hunkTextLength,
  };
}

function countLinesTextLength(lines: readonly string[]): number {
  let length = 0;
  for (const line of lines) {
    length += line.length;
  }
  return length;
}
