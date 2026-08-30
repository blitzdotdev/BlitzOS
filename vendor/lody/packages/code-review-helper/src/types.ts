export type ReviewSeverity = 'error' | 'warning' | 'info';

export interface ReviewDiagnostic {
  readonly severity: ReviewSeverity;
  readonly message: string;
  readonly line?: number;
  readonly code?: string;
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export type ReviewSide = 'old' | 'new';

/**
 * Note severity / review priority. Issues are flagged by priority:
 * `p0` (must fix before merge — bugs, breaking changes, data loss, security),
 * `p1` (should fix — real risks / behavior changes), `p2` (minor / nit / optional).
 * `question` asks the author (not a bug); `info` (default) is neutral context.
 */
export type ReviewNoteSeverity = 'p0' | 'p1' | 'p2' | 'question' | 'info';

export interface ReviewPullRequest {
  readonly number: number;
  readonly url: string;
  readonly title?: string;
}

export interface ReviewFrontmatter {
  readonly reviewVersion: 1;
  readonly mergeBase: string;
  readonly currentCommit: string;
  readonly baseRef?: string;
  readonly lineBudget: number;
  readonly pr?: ReviewPullRequest;
  readonly raw: Record<string, string>;
}

export interface ReviewNote {
  readonly id: string;
  readonly side: ReviewSide;
  readonly range: LineRange;
  readonly body: string;
  /** Severity prefix from the review file (`P0`/`P1`/`P2`/`QUESTION`/`INFO`); defaults to info. */
  readonly severity?: ReviewNoteSeverity;
  readonly path: string;
  readonly blockId: string;
  readonly line: number;
}

export interface ReviewChangeBlock {
  readonly id: string;
  readonly path: string;
  readonly kind: 'change' | 'context';
  readonly oldRange?: LineRange;
  readonly newRange?: LineRange;
  readonly notes: ReviewNote[];
  readonly line: number;
  readonly rawReference: string;
}

export interface ReviewGroup {
  readonly id: string;
  readonly title: string;
  readonly changedLines?: number;
  readonly commits: string[];
  readonly bodyMarkdown: string;
  readonly blocks: ReviewChangeBlock[];
  readonly line: number;
}

/**
 * A code-location reference inside a `## Review` finding. Unlike inline notes,
 * findings carry the path explicitly (`new://<path>:Lx-Ly`, `old://<path>:Lx`, or a
 * bare `<path>` for a whole file) so a single finding can point at many locations
 * across files. The renderer turns each ref into a clickable file-label chip that
 * jumps the center diff to that location.
 */
export interface ReviewFindingRef {
  /** Repository-relative path of the referenced file. */
  readonly path: string;
  /** Diff side; `new` (current commit) by default, `old` for the merge-base version. */
  readonly side: ReviewSide;
  /** Line range within the file; omitted for a whole-file reference. */
  readonly range?: LineRange;
  /** The exact backticked token as written, for rendering the label. */
  readonly raw: string;
}

/**
 * A top-level `## Review` finding: a cross-cutting, high-signal conclusion (usually
 * `P0`/`P1`/`P2`) that may reference several code locations. Listed at the top of the
 * review, separate from inline `INFO`/`QUESTION` notes.
 */
export interface ReviewFinding {
  readonly id: string;
  readonly severity: ReviewNoteSeverity;
  /** Description markdown, with `code`-span refs kept inline for chip rendering. */
  readonly bodyMarkdown: string;
  readonly refs: ReviewFindingRef[];
  readonly line: number;
}

export interface ReviewDocument {
  readonly sourcePath?: string;
  readonly frontmatter: ReviewFrontmatter;
  /** Overall review title extracted from the first `# Title` line in the overview. */
  readonly title?: string;
  /** Markdown written before the first `## Group:` heading — an overall summary of the change. */
  readonly overview?: string;
  /**
   * Findings from the top-level `## Review` section (may be empty). Optional so
   * snapshots produced before this field existed still type-check; the parser always
   * sets it, readers should treat a missing value as `[]`.
   */
  readonly findings?: ReviewFinding[];
  readonly groups: ReviewGroup[];
  readonly diagnostics: ReviewDiagnostic[];
}

export interface ReviewResolvedCommit {
  /** The exact ref string used in the review file (often an abbreviated sha). */
  readonly ref: string;
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly body: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate?: string;
}

export type ReviewFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'unknown';

export interface ReviewResolvedFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly status: ReviewFileStatus;
  readonly oldText: string;
  readonly newText: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary?: boolean;
  readonly diagnostics: ReviewDiagnostic[];
}

export interface ReviewResolvedBlock extends ReviewChangeBlock {
  readonly file?: ReviewResolvedFile;
  readonly displayOldText: string;
  readonly displayNewText: string;
  readonly diagnostics: ReviewDiagnostic[];
}

export interface ReviewResolvedGroup extends Omit<ReviewGroup, 'blocks'> {
  readonly blocks: ReviewResolvedBlock[];
  readonly diagnostics: ReviewDiagnostic[];
}

export interface ReviewBundle {
  readonly reviewFilePath?: string;
  readonly repoPath?: string;
  readonly document: ReviewDocument;
  readonly groups: ReviewResolvedGroup[];
  readonly files: Record<string, ReviewResolvedFile>;
  /** Resolved commit metadata keyed by the ref string used in the review file. */
  readonly commits: Record<string, ReviewResolvedCommit>;
  readonly diagnostics: ReviewDiagnostic[];
}

export interface ReviewCommentAnchor {
  readonly path: string;
  readonly side: ReviewSide;
  readonly lineNumber: number;
}

export interface ReviewUserComment {
  readonly id: string;
  readonly anchor: ReviewCommentAnchor;
  readonly body: string;
  readonly lineText?: string;
  readonly createdAt: number;
}
