import { describe, expect, it } from 'vitest';

import { parseLineRange, parseReviewMarkdown } from '../src/parser';
import { validateParsedReviewDocument } from '../src/validation';

const sample = `---
review_version: 1
merge_base: 1111111
current_commit: 2222222
line_budget: 1500
---

# Refactor adaptor public surface

This change removes legacy aliases and centralizes label casing.

## Group: Remove redundant adaptor module

Changed lines: 820
Commits: \`abc123\`, \`def456\`

The adaptor barrel was simplified.

\`changes://packages/adaptors/src/index.ts?old=L128-L256&new=L1-L80\`

- \`old://L128-L256\`: this old logic should be dead.
- \`new://L12\`: confirm naming.
`;

describe('parseReviewMarkdown', () => {
  it('parses frontmatter, title, overview, groups, changes blocks, and implicitly bound notes', () => {
    const document = parseReviewMarkdown(sample);

    expect(document.frontmatter.mergeBase).toBe('1111111');
    expect(document.frontmatter.currentCommit).toBe('2222222');
    expect(document.title).toBe('Refactor adaptor public surface');
    expect(document.overview).toBe(
      'This change removes legacy aliases and centralizes label casing.'
    );
    expect(document.groups).toHaveLength(1);
    expect(document.groups[0]?.title).toBe('Remove redundant adaptor module');
    expect(document.groups[0]?.changedLines).toBe(820);
    expect(document.groups[0]?.commits).toEqual(['abc123', 'def456']);
    expect(document.groups[0]?.blocks[0]?.path).toBe('packages/adaptors/src/index.ts');
    expect(document.groups[0]?.blocks[0]?.oldRange).toEqual({ start: 128, end: 256 });
    expect(document.groups[0]?.blocks[0]?.newRange).toEqual({ start: 1, end: 80 });
    expect(document.groups[0]?.blocks[0]?.notes).toHaveLength(2);
    expect(document.groups[0]?.blocks[0]?.notes[0]?.side).toBe('old');
    expect(document.diagnostics).toEqual([]);
  });

  it('parses optional PR frontmatter fields', () => {
    const document = parseReviewMarkdown(`---
review_version: 1
merge_base: a
current_commit: b
pr_number: 2451
pr_url: https://github.com/loro-dev/lody/pull/2451
pr_title: Adapter refactor
---

# Adapter refactor

## Group: A

\`changes://a.ts\`
`);

    expect(document.frontmatter.pr).toEqual({
      number: 2451,
      url: 'https://github.com/loro-dev/lody/pull/2451',
      title: 'Adapter refactor',
    });
    expect(document.title).toBe('Adapter refactor');
  });

  it('warns when the overview does not start with a level-1 title', () => {
    const document = parseReviewMarkdown(`---
review_version: 1
merge_base: a
current_commit: b
---

Just a summary without a title.

## Group: A

\`changes://a.ts\`
`);

    expect(document.title).toBeUndefined();
    expect(
      document.diagnostics.some((diagnostic) => diagnostic.code === 'missing_review_title')
    ).toBe(true);
  });

  it('reports unbound old/new notes', () => {
    const document = parseReviewMarkdown(`---
review_version: 1
merge_base: a
current_commit: b
---

## Group: Bad refs

- \`new://L1\`: no block yet.
`);

    expect(
      document.diagnostics.some((diagnostic) => diagnostic.code === 'unbound_line_reference')
    ).toBe(true);
  });

  it('warns when declared group lines exceed budget', () => {
    const document = parseReviewMarkdown(`---
review_version: 1
merge_base: a
current_commit: b
line_budget: 10
---

## Group: Big

Changed lines: 11

\`changes://a.ts\`
`);

    expect(validateParsedReviewDocument(document)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'group_over_budget' })])
    );
  });

  it('parses context:// blocks for unchanged files', () => {
    const document = parseReviewMarkdown(`---
review_version: 1
merge_base: a
current_commit: b
---

## Group: Context

\`context://src/unchanged.ts?range=L10-L20\`

- INFO \`new://L12\`: call site that consumes the changed API.
`);

    expect(document.groups).toHaveLength(1);
    const block = document.groups[0]?.blocks[0];
    expect(block?.kind).toBe('context');
    expect(block?.path).toBe('src/unchanged.ts');
    expect(block?.newRange).toEqual({ start: 10, end: 20 });
    expect(block?.oldRange).toBeUndefined();
    expect(block?.notes[0]?.severity).toBe('info');
  });

  it('parses P0/P1/P2/QUESTION priorities and maps legacy ERROR/WARNING', () => {
    const document = parseReviewMarkdown(`---
review_version: 1
merge_base: a
current_commit: b
---

## Group: Q

\`changes://a.ts\`

- QUESTION \`new://L5\`: why is this value hard-coded?
- P1 \`new://L6\`: possible off-by-one.
- P0 \`new://L7\`: drops null guard.
- P2 \`new://L8\`: stray debug log.
- WARNING \`new://L9\`: legacy warning maps to P1.
- ERROR \`new://L10\`: legacy error maps to P0.
`);

    const notes = document.groups[0]?.blocks[0]?.notes;
    expect(notes?.map((note) => note.severity)).toEqual(['question', 'p1', 'p0', 'p2', 'p1', 'p0']);
  });

  it('lowercases the note side even when written in upper/mixed case', () => {
    const document = parseReviewMarkdown(`---
review_version: 1
merge_base: a
current_commit: b
---

# Casing review

## Group: Casing

\`changes://a.ts\`

- \`OLD://L5\`: uppercase side.
- \`New://L6\`: mixed-case side.
`);

    const notes = document.groups[0]?.blocks[0]?.notes;
    expect(notes?.map((note) => note.side)).toEqual(['old', 'new']);
    expect(document.diagnostics).toEqual([]);
  });

  it('parses a top-level `## Review` section into findings with path-qualified refs', () => {
    const document = parseReviewMarkdown(`---
review_version: 1
merge_base: a
current_commit: b
---

# Findings demo

## Review

- P0: breaking rename spans two files \`new://src/index.ts:L9\` and \`old://src/index.ts:L9-L16\`.
- P1: keep scripts local — \`new://pkg/package.json:L18-L22\`.
- P2: nit, see \`src/naming.ts\`.

## Group: A

\`changes://src/index.ts\`
`);

    const findings = document.findings ?? [];
    expect(findings.map((finding) => finding.severity)).toEqual(['p0', 'p1', 'p2']);
    // P0 carries two refs across new/old sides.
    expect(findings[0]?.refs).toEqual([
      {
        path: 'src/index.ts',
        side: 'new',
        range: { start: 9, end: 9 },
        raw: 'new://src/index.ts:L9',
      },
      {
        path: 'src/index.ts',
        side: 'old',
        range: { start: 9, end: 16 },
        raw: 'old://src/index.ts:L9-L16',
      },
    ]);
    // Bare path ref (no scheme/line) resolves to a whole-file new-side ref.
    expect(findings[2]?.refs).toEqual([
      { path: 'src/naming.ts', side: 'new', raw: 'src/naming.ts' },
    ]);
    // The `## Review` section is not treated as a group, and its bullets do not leak
    // into the overview.
    expect(document.title).toBe('Findings demo');
    expect(document.overview ?? '').not.toContain('breaking rename');
    expect(document.groups).toHaveLength(1);
  });

  it('warns when a `## Review` finding references a file not shown in any group', () => {
    const document = parseReviewMarkdown(`---
review_version: 1
merge_base: a
current_commit: b
---

# T

## Review

- P0: shown \`new://src/shown.ts:L3\`; missing \`new://src/missing.ts:L9\`.

## Group: G

\`changes://src/shown.ts\`
`);

    const unresolved = validateParsedReviewDocument(document).filter(
      (diagnostic) => diagnostic.code === 'finding_ref_unresolved'
    );
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.message).toContain('src/missing.ts');
  });
});

describe('parseLineRange', () => {
  it('accepts single lines and ranges', () => {
    expect(parseLineRange('L12')).toEqual({ start: 12, end: 12 });
    expect(parseLineRange('L12-L18')).toEqual({ start: 12, end: 18 });
    expect(parseLineRange('L12-18')).toEqual({ start: 12, end: 18 });
  });

  it('rejects malformed ranges', () => {
    expect(parseLineRange('12')).toBeUndefined();
    expect(parseLineRange('L9-L2')).toBeUndefined();
  });
});
