import type {
  LineRange,
  ReviewDiagnostic,
  ReviewDocument,
  ReviewFinding,
  ReviewFindingRef,
  ReviewFrontmatter,
  ReviewGroup,
  ReviewNote,
  ReviewNoteSeverity,
  ReviewPullRequest,
  ReviewSide,
} from './types';

const FRONTMATTER_DELIMITER = '---';
const DEFAULT_LINE_BUDGET = 1500;
const GROUP_HEADING = /^##\s+Group:\s*(.+?)\s*$/u;
const CHANGED_LINES = /^Changed lines:\s*(\d+)\s*$/iu;
const COMMITS = /^Commits:\s*(.*?)\s*$/iu;
const CODE_SPAN = /`([^`]+)`/gu;
const CHANGE_REF = /^`(changes:\/\/[^`]+)`\s*$/u;
const CONTEXT_REF = /^`(context:\/\/[^`]+)`\s*$/u;
// The colon after the backtick reference may be ASCII `:` or fullwidth `：` (common
// when the review is written in CJK languages), so reviews don't silently lose notes.
const NOTE_REF =
  /^\s*-\s*(?:(P0|P1|P2|QUESTION|INFO|WARNING|ERROR)\s+)?`(old|new):\/\/([^`]+)`\s*[:：]\s*(.+?)\s*$/iu;

// Top-level `## Review` findings section: a heading plus `- <SEVERITY>: <text>` bullets.
const REVIEW_HEADING = /^##\s+Review\s*$/iu;
const FINDING_ENTRY = /^\s*-\s*(P0|P1|P2|QUESTION|INFO|WARNING|ERROR)\b\s*[:：]\s*(.*)$/iu;
// A code-location reference inside a finding: `old|new://<path>[:Lx[-Ly]]`.
const REVIEW_REF_SCHEME = /^(old|new):\/\/(.+?)(?::L(\d+)(?:-L?(\d+))?)?$/iu;
// A bare repo-relative path with at least one directory segment and a file extension,
// e.g. `flock-rs/src/file_v2.rs` — used so `<path>` chips don't false-match `foo()`.
const REVIEW_REF_BARE_PATH = /^(?:[\w.@~-]+\/)+[\w.@~-]+\.[A-Za-z0-9]+$/u;

/**
 * Parses a single backticked token as a `## Review` finding code reference, or returns
 * `null` if it isn't one (so ordinary inline code stays plain). Shared with the
 * renderer so chips and parsed refs agree.
 */
export function parseReviewRef(token: string): ReviewFindingRef | null {
  const trimmed = token.trim();
  const scheme = REVIEW_REF_SCHEME.exec(trimmed);
  if (scheme) {
    const path = (scheme[2] ?? '').trim();
    if (path.length === 0) {
      return null;
    }
    const side = (scheme[1] ?? 'new').toLowerCase() as ReviewSide;
    const startRaw = scheme[3];
    let range: LineRange | undefined;
    if (startRaw !== undefined) {
      const start = Number(startRaw);
      const end = scheme[4] === undefined ? start : Number(scheme[4]);
      if (Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start) {
        range = { start, end };
      }
    }
    return { path, side, ...(range ? { range } : {}), raw: trimmed };
  }
  if (REVIEW_REF_BARE_PATH.test(trimmed)) {
    return { path: trimmed, side: 'new', raw: trimmed };
  }
  return null;
}

function extractReviewRefs(text: string): ReviewFindingRef[] {
  const refs: ReviewFindingRef[] = [];
  for (const match of text.matchAll(CODE_SPAN)) {
    const ref = parseReviewRef(match[1] ?? '');
    if (ref) {
      refs.push(ref);
    }
  }
  return refs;
}

function parseReviewFindings(lines: readonly string[], baseLineNumber: number): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  let current: { severity: ReviewNoteSeverity; bodyLines: string[]; line: number } | undefined;
  const flush = (): void => {
    if (!current) {
      return;
    }
    const bodyMarkdown = trimOuterBlankLines(current.bodyLines).join('\n').trim();
    findings.push({
      id: `finding-${findings.length + 1}`,
      severity: current.severity,
      bodyMarkdown,
      refs: extractReviewRefs(bodyMarkdown),
      line: current.line,
    });
    current = undefined;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    const entry = FINDING_ENTRY.exec(rawLine);
    if (entry) {
      flush();
      current = {
        severity: normalizeNoteSeverity(entry[1]),
        bodyLines: [entry[2] ?? ''],
        line: baseLineNumber + index,
      };
      continue;
    }
    if (current) {
      current.bodyLines.push(rawLine);
    }
  }
  flush();
  return findings;
}

// Map a note's severity token to its priority. `ERROR`/`WARNING` are legacy aliases
// (review files now use P0/P1/P2); they map to P0/P1 so old files keep rendering.
function normalizeNoteSeverity(token: string | undefined): ReviewNoteSeverity {
  switch (token?.toUpperCase()) {
    case 'P0':
    case 'ERROR':
      return 'p0';
    case 'P1':
    case 'WARNING':
      return 'p1';
    case 'P2':
      return 'p2';
    case 'QUESTION':
      return 'question';
    default:
      return 'info';
  }
}

interface MutableGroup {
  id: string;
  title: string;
  changedLines?: number;
  commits: string[];
  bodyLines: string[];
  blocks: MutableBlock[];
  line: number;
}

interface MutableBlock {
  id: string;
  path: string;
  kind: 'change' | 'context';
  oldRange?: LineRange;
  newRange?: LineRange;
  notes: ReviewNote[];
  line: number;
  rawReference: string;
}

export interface ParseReviewMarkdownOptions {
  readonly sourcePath?: string;
}

export function parseReviewMarkdown(
  markdown: string,
  options: ParseReviewMarkdownOptions = {}
): ReviewDocument {
  const diagnostics: ReviewDiagnostic[] = [];
  const normalized = markdown.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  const { frontmatter, bodyStartIndex } = parseFrontmatter(lines, diagnostics);
  const { groups, title, overview, findings } = parseGroups(lines, bodyStartIndex, diagnostics);

  if (title === undefined) {
    diagnostics.push({
      severity: 'warning',
      message: 'Review should start the overview with a "# Title" heading.',
      line: bodyStartIndex + 1,
      code: 'missing_review_title',
    });
  }

  if (groups.length === 0) {
    diagnostics.push({
      severity: 'error',
      message: 'Review file must contain at least one "## Group: ..." section.',
      code: 'missing_group',
    });
  }

  return {
    ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
    frontmatter,
    ...(title === undefined ? {} : { title }),
    ...(overview === undefined ? {} : { overview }),
    findings,
    groups,
    diagnostics,
  };
}

function parseFrontmatter(
  lines: readonly string[],
  diagnostics: ReviewDiagnostic[]
): { frontmatter: ReviewFrontmatter; bodyStartIndex: number } {
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    diagnostics.push({
      severity: 'error',
      message: 'Review file must start with YAML frontmatter delimited by "---".',
      line: 1,
      code: 'missing_frontmatter',
    });
    return {
      frontmatter: fallbackFrontmatter({}),
      bodyStartIndex: 0,
    };
  }

  const raw: Record<string, string> = {};
  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.trim() === FRONTMATTER_DELIMITER) {
      endIndex = index;
      break;
    }
    const parsed = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/u.exec(line ?? '');
    if (!parsed) {
      diagnostics.push({
        severity: 'warning',
        message: `Ignoring unsupported frontmatter line: ${line ?? ''}`,
        line: index + 1,
        code: 'unsupported_frontmatter_line',
      });
      continue;
    }
    raw[parsed[1] ?? ''] = stripYamlScalar(parsed[2] ?? '');
  }

  if (endIndex === -1) {
    diagnostics.push({
      severity: 'error',
      message: 'Frontmatter is missing a closing "---" delimiter.',
      line: 1,
      code: 'unterminated_frontmatter',
    });
    return { frontmatter: fallbackFrontmatter(raw), bodyStartIndex: lines.length };
  }

  const frontmatter = fallbackFrontmatter(raw);
  if (raw.review_version !== '1') {
    diagnostics.push({
      severity: 'error',
      message: 'frontmatter.review_version must be 1.',
      line: 2,
      code: 'invalid_review_version',
    });
  }
  if (!raw.merge_base) {
    diagnostics.push({
      severity: 'error',
      message: 'frontmatter.merge_base is required.',
      line: 2,
      code: 'missing_merge_base',
    });
  }
  if (!raw.current_commit) {
    diagnostics.push({
      severity: 'error',
      message: 'frontmatter.current_commit is required.',
      line: 2,
      code: 'missing_current_commit',
    });
  }
  if (raw.line_budget !== undefined && !Number.isFinite(Number(raw.line_budget))) {
    diagnostics.push({
      severity: 'warning',
      message: `frontmatter.line_budget is not a number; using ${DEFAULT_LINE_BUDGET}.`,
      line: 2,
      code: 'invalid_line_budget',
    });
  }

  return { frontmatter, bodyStartIndex: endIndex + 1 };
}

function fallbackFrontmatter(raw: Record<string, string>): ReviewFrontmatter {
  const parsedBudget = Number(raw.line_budget);
  return {
    reviewVersion: 1,
    mergeBase: raw.merge_base ?? '',
    currentCommit: raw.current_commit ?? '',
    ...(raw.base_ref === undefined || raw.base_ref.length === 0 ? {} : { baseRef: raw.base_ref }),
    lineBudget:
      Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : DEFAULT_LINE_BUDGET,
    pr: parsePullRequest(raw),
    raw,
  };
}

function parsePullRequest(raw: Record<string, string>): ReviewPullRequest | undefined {
  const numberRaw = raw.pr_number;
  const urlRaw = raw.pr_url;
  if (numberRaw === undefined && urlRaw === undefined) {
    return undefined;
  }
  const number = Number(numberRaw);
  const url = urlRaw ?? '';
  if (!Number.isInteger(number) || number <= 0) {
    return undefined;
  }
  if (!isValidUrl(url)) {
    return undefined;
  }
  const title = raw.pr_title;
  return {
    number,
    url,
    ...(title === undefined || title.length === 0 ? {} : { title }),
  };
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseGroups(
  lines: readonly string[],
  bodyStartIndex: number,
  diagnostics: ReviewDiagnostic[]
): { groups: ReviewGroup[]; title?: string; overview?: string; findings: ReviewFinding[] } {
  const groups: MutableGroup[] = [];
  const overviewLines: string[] = [];
  const reviewLines: string[] = [];
  let reviewStartLine = 0;
  let inReview = false;
  let currentGroup: MutableGroup | undefined;
  let currentBlock: MutableBlock | undefined;

  for (let index = bodyStartIndex; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    const lineNumber = index + 1;
    const heading = GROUP_HEADING.exec(rawLine);
    if (heading) {
      inReview = false;
      currentGroup = {
        id: `group-${groups.length + 1}`,
        title: heading[1]?.trim() ?? `Group ${groups.length + 1}`,
        commits: [],
        bodyLines: [],
        blocks: [],
        line: lineNumber,
      };
      groups.push(currentGroup);
      currentBlock = undefined;
      continue;
    }

    // A top-level `## Review` section (before the first group) holds findings.
    if (!currentGroup && REVIEW_HEADING.test(rawLine)) {
      inReview = true;
      reviewStartLine = lineNumber + 1;
      continue;
    }

    if (!currentGroup) {
      // Content before the first group is either the `## Review` findings or, before
      // any `## Review` heading, the overall change summary (overview).
      (inReview ? reviewLines : overviewLines).push(rawLine);
      continue;
    }

    const changedLines = CHANGED_LINES.exec(rawLine);
    if (changedLines) {
      currentGroup.changedLines = Number(changedLines[1]);
      currentGroup.bodyLines.push(rawLine);
      continue;
    }

    const commits = COMMITS.exec(rawLine);
    if (commits) {
      currentGroup.commits = parseCommits(commits[1] ?? '');
      currentGroup.bodyLines.push(rawLine);
      continue;
    }

    const changeRef = CHANGE_REF.exec(rawLine.trim());
    if (changeRef) {
      const parsedRef = parseChangeReference(changeRef[1] ?? '');
      if (!parsedRef) {
        diagnostics.push({
          severity: 'error',
          message: `Invalid changes reference: ${changeRef[1] ?? ''}`,
          line: lineNumber,
          code: 'invalid_changes_reference',
        });
        currentBlock = undefined;
        continue;
      }
      currentBlock = {
        id: `${currentGroup.id}-block-${currentGroup.blocks.length + 1}`,
        path: parsedRef.path,
        kind: 'change',
        ...(parsedRef.oldRange === undefined ? {} : { oldRange: parsedRef.oldRange }),
        ...(parsedRef.newRange === undefined ? {} : { newRange: parsedRef.newRange }),
        notes: [],
        line: lineNumber,
        rawReference: changeRef[1] ?? '',
      };
      currentGroup.blocks.push(currentBlock);
      continue;
    }

    const contextRef = CONTEXT_REF.exec(rawLine.trim());
    if (contextRef) {
      const parsedRef = parseContextReference(contextRef[1] ?? '');
      if (!parsedRef) {
        diagnostics.push({
          severity: 'error',
          message: `Invalid context reference: ${contextRef[1] ?? ''}`,
          line: lineNumber,
          code: 'invalid_context_reference',
        });
        currentBlock = undefined;
        continue;
      }
      currentBlock = {
        id: `${currentGroup.id}-block-${currentGroup.blocks.length + 1}`,
        path: parsedRef.path,
        kind: 'context',
        newRange: parsedRef.range,
        notes: [],
        line: lineNumber,
        rawReference: contextRef[1] ?? '',
      };
      currentGroup.blocks.push(currentBlock);
      continue;
    }

    const noteRef = NOTE_REF.exec(rawLine);
    if (noteRef) {
      // NOTE_REF is case-insensitive, so lowercase the captured side to match the
      // 'old'/'new' literals compared downstream (validation, diff annotations).
      const side = noteRef[2]?.toLowerCase();
      if (!currentBlock) {
        diagnostics.push({
          severity: 'error',
          message: `${side ?? 'line'} reference has no preceding changes:// block.`,
          line: lineNumber,
          code: 'unbound_line_reference',
        });
        continue;
      }
      const range = parseLineRange(noteRef[3] ?? '');
      if (!range) {
        diagnostics.push({
          severity: 'error',
          message: `Invalid ${side} line range: ${noteRef[3] ?? ''}`,
          line: lineNumber,
          code: 'invalid_line_range',
        });
        continue;
      }
      currentBlock.notes.push({
        id: `${currentBlock.id}-note-${currentBlock.notes.length + 1}`,
        side: side as ReviewSide,
        severity: normalizeNoteSeverity(noteRef[1]),
        range,
        body: noteRef[4] ?? '',
        path: currentBlock.path,
        blockId: currentBlock.id,
        line: lineNumber,
      });
      continue;
    }

    currentGroup.bodyLines.push(rawLine);
  }

  const trimmedOverview = trimOuterBlankLines(overviewLines);
  let title: string | undefined;
  if (trimmedOverview.length > 0) {
    const firstLine = trimmedOverview[0]?.trim() ?? '';
    const titleMatch = /^#\s+(.+)$/u.exec(firstLine);
    if (titleMatch) {
      title = titleMatch[1]?.trim();
      trimmedOverview.shift();
    }
  }
  const overview = trimOuterBlankLines(trimmedOverview).join('\n').trim();

  const resolvedGroups: ReviewGroup[] = groups.map((group) => ({
    id: group.id,
    title: group.title,
    ...(group.changedLines === undefined ? {} : { changedLines: group.changedLines }),
    commits: group.commits,
    bodyMarkdown: trimOuterBlankLines(group.bodyLines).join('\n'),
    blocks: group.blocks.map((block) => ({
      id: block.id,
      path: block.path,
      kind: block.kind,
      ...(block.oldRange === undefined ? {} : { oldRange: block.oldRange }),
      ...(block.newRange === undefined ? {} : { newRange: block.newRange }),
      notes: block.notes,
      line: block.line,
      rawReference: block.rawReference,
    })),
    line: group.line,
  }));

  const findings = parseReviewFindings(reviewLines, reviewStartLine);

  return {
    groups: resolvedGroups,
    findings,
    ...(title === undefined ? {} : { title }),
    ...(overview.length === 0 ? {} : { overview }),
  };
}

function parseCommits(value: string): string[] {
  const commits: string[] = [];
  for (const match of value.matchAll(CODE_SPAN)) {
    const commit = match[1]?.trim();
    if (commit) {
      commits.push(commit);
    }
  }
  if (commits.length > 0) {
    return commits;
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseChangeReference(reference: string):
  | {
      readonly path: string;
      readonly oldRange?: LineRange;
      readonly newRange?: LineRange;
    }
  | undefined {
  if (!reference.startsWith('changes://')) {
    return undefined;
  }
  const withoutScheme = reference.slice('changes://'.length);
  const queryStart = withoutScheme.indexOf('?');
  const rawPath = queryStart === -1 ? withoutScheme : withoutScheme.slice(0, queryStart);
  const query = queryStart === -1 ? '' : withoutScheme.slice(queryStart + 1);
  const path = safeDecode(rawPath);
  if (path.length === 0 || path.startsWith('/')) {
    return undefined;
  }
  const params = new URLSearchParams(query);
  const oldRange = parseLineRange(params.get('old') ?? '');
  const newRange = parseLineRange(params.get('new') ?? '');
  return {
    path,
    ...(oldRange === undefined ? {} : { oldRange }),
    ...(newRange === undefined ? {} : { newRange }),
  };
}

function parseContextReference(reference: string):
  | {
      readonly path: string;
      readonly range: LineRange;
    }
  | undefined {
  if (!reference.startsWith('context://')) {
    return undefined;
  }
  const withoutScheme = reference.slice('context://'.length);
  const queryStart = withoutScheme.indexOf('?');
  const rawPath = queryStart === -1 ? withoutScheme : withoutScheme.slice(0, queryStart);
  const query = queryStart === -1 ? '' : withoutScheme.slice(queryStart + 1);
  const path = safeDecode(rawPath);
  if (path.length === 0 || path.startsWith('/')) {
    return undefined;
  }
  const params = new URLSearchParams(query);
  const range = parseLineRange(params.get('range') ?? params.get('L') ?? '');
  if (range === undefined) {
    return undefined;
  }
  return { path, range };
}

export function parseLineRange(value: string): LineRange | undefined {
  const trimmed = value.trim();
  const match = /^L(\d+)(?:-L?(\d+))?$/iu.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) {
    return undefined;
  }
  return { start, end };
}

function trimOuterBlankLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === '') {
    start += 1;
  }
  while (end > start && lines[end - 1]?.trim() === '') {
    end -= 1;
  }
  return lines.slice(start, end);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isValidUrl(value: string): boolean {
  try {
    void new URL(value);
    return true;
  } catch {
    return false;
  }
}
