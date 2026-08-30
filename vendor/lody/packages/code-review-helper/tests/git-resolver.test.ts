import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { resolveReviewBundle } from '../src/node';
import { collectBundleDiagnostics } from '../src/validation';

const execFileAsync = promisify(execFile);

describe('resolveReviewBundle', () => {
  it('resolves modified, added, deleted, and renamed files', async () => {
    const repoPath = await mkdtemp(path.join(os.tmpdir(), 'review-helper-'));
    await git(repoPath, ['init']);
    await git(repoPath, ['config', 'user.email', 'review-helper@example.com']);
    await git(repoPath, ['config', 'user.name', 'Review Helper']);
    await writeFile(path.join(repoPath, 'modified.ts'), 'export const value = 1;\n');
    await writeFile(path.join(repoPath, 'deleted.ts'), 'export const deleted = true;\n');
    await writeFile(
      path.join(repoPath, 'renamed-old.ts'),
      [
        'export function renamed() {',
        '  const first = 1;',
        '  const second = 2;',
        '  const third = 3;',
        '  return first + second + third;',
        '}',
        '',
      ].join('\n')
    );
    await git(repoPath, ['add', '.']);
    await git(repoPath, ['commit', '-m', 'base']);
    const mergeBase = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();

    await writeFile(path.join(repoPath, 'modified.ts'), 'export const value = 2;\n');
    await writeFile(path.join(repoPath, 'added.ts'), 'export const added = true;\n');
    await git(repoPath, ['mv', 'renamed-old.ts', 'renamed-new.ts']);
    await writeFile(
      path.join(repoPath, 'renamed-new.ts'),
      [
        'export function renamed() {',
        '  const first = 1;',
        '  const second = 20;',
        '  const third = 3;',
        '  return first + second + third;',
        '}',
        '',
      ].join('\n')
    );
    await git(repoPath, ['rm', 'deleted.ts']);
    await git(repoPath, ['add', '.']);
    await git(repoPath, ['commit', '-m', 'head']);
    const currentCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();

    const reviewPath = path.join(repoPath, 'sample.review.md');
    await writeFile(
      reviewPath,
      `---
review_version: 1
merge_base: ${mergeBase}
current_commit: ${currentCommit}
line_budget: 1500
---

## Group: Files

Changed lines: 8

\`changes://modified.ts\`
\`changes://added.ts\`
\`changes://deleted.ts\`
\`changes://renamed-new.ts\`
`
    );

    const bundle = await resolveReviewBundle({ reviewFilePath: reviewPath, repoPath });
    expect(bundle.files['modified.ts']?.status).toBe('modified');
    expect(bundle.files['added.ts']?.status).toBe('added');
    expect(bundle.files['deleted.ts']?.status).toBe('deleted');
    expect(bundle.files['renamed-new.ts']?.status).toBe('renamed');
    expect(bundle.files['renamed-new.ts']?.oldPath).toBe('renamed-old.ts');
    expect(
      collectBundleDiagnostics(bundle).filter((diagnostic) => diagnostic.severity === 'error')
    ).toEqual([]);

    // Regression: document-level diagnostics (here `missing_review_title`, since the
    // review has no `# Title`) must appear exactly once — `collectBundleDiagnostics`
    // must not re-run `validateParsedReviewDocument` on top of `bundle.diagnostics`.
    const titleWarnings = collectBundleDiagnostics(bundle).filter(
      (diagnostic) => diagnostic.code === 'missing_review_title'
    );
    expect(titleWarnings).toHaveLength(1);
  });
});

async function git(repoPath: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
  });
  return result.stdout;
}
