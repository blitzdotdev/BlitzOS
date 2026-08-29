import { parseReviewMarkdown } from '../parser';
import { createSparseTextForRanges } from '../sparse-text';
import type {
  LineRange,
  ReviewBundle,
  ReviewDiagnostic,
  ReviewFileStatus,
  ReviewResolvedBlock,
  ReviewResolvedCommit,
  ReviewResolvedFile,
  ReviewResolvedGroup,
} from '../types';
import { countLines, validateResolvedBlock } from '../validation';

interface FixtureFileInput {
  readonly path: string;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly status: ReviewFileStatus;
  readonly oldText: string;
  readonly newText: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly diagnostics?: readonly ReviewDiagnostic[];
}

export type FixtureCommitInput = Omit<ReviewResolvedCommit, 'shortSha' | 'sha'> & {
  readonly sha?: string;
  readonly shortSha?: string;
};

export interface ReviewFixtureBundleInput {
  readonly markdown: string;
  readonly reviewFilePath: string;
  readonly files: readonly FixtureFileInput[];
  readonly commits?: readonly FixtureCommitInput[];
  readonly repoPath?: string;
}

export function createReviewFixtureBundle(input: ReviewFixtureBundleInput): ReviewBundle {
  const document = parseReviewMarkdown(input.markdown, { sourcePath: input.reviewFilePath });
  const files = Object.fromEntries(
    input.files.map((file) => [file.path, createResolvedFile(file)])
  ) as Record<string, ReviewResolvedFile>;

  const groups: ReviewResolvedGroup[] = document.groups.map((group) => {
    const blocks: ReviewResolvedBlock[] = group.blocks.map((block) => {
      const file = files[block.path];
      const rangeFiltered = block.oldRange !== undefined || block.newRange !== undefined;
      const displayOldText =
        file === undefined
          ? ''
          : rangeFiltered
            ? sparseOrBlank(file.oldText, block.oldRange)
            : file.oldText;
      const displayNewText =
        file === undefined
          ? ''
          : rangeFiltered
            ? sparseOrBlank(file.newText, block.newRange)
            : file.newText;
      const resolvedBlock: ReviewResolvedBlock = {
        ...block,
        ...(file === undefined ? {} : { file }),
        displayOldText,
        displayNewText,
        diagnostics: [],
      };
      return {
        ...resolvedBlock,
        diagnostics: validateResolvedBlock(resolvedBlock),
      };
    });

    return {
      ...group,
      blocks,
      diagnostics: [],
    };
  });

  const commits: Record<string, ReviewResolvedCommit> = {};
  for (const commit of input.commits ?? []) {
    const ref = commit.ref;
    commits[ref] = {
      ...commit,
      sha: commit.sha ?? ref,
      shortSha: commit.shortSha ?? ref.slice(0, 7),
    };
  }

  return {
    reviewFilePath: input.reviewFilePath,
    repoPath: input.repoPath ?? '/storybook/repo',
    document,
    groups,
    files,
    commits,
    diagnostics: [],
  };
}

export function source(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

function createResolvedFile(input: FixtureFileInput): ReviewResolvedFile {
  return {
    path: input.path,
    ...(input.oldPath === undefined ? {} : { oldPath: input.oldPath }),
    ...(input.newPath === undefined ? {} : { newPath: input.newPath }),
    status: input.status,
    oldText: input.oldText,
    newText: input.newText,
    additions: input.additions ?? countLines(input.newText),
    deletions: input.deletions ?? countLines(input.oldText),
    diagnostics: [...(input.diagnostics ?? [])],
  };
}

function sparseOrBlank(text: string, range: LineRange | undefined): string {
  if (range === undefined) {
    const lineCount = countLines(text);
    return lineCount === 0 ? '' : Array.from({ length: lineCount }, () => '').join('\n');
  }
  return createSparseTextForRanges(text, [range]);
}
