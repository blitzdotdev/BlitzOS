import { describe, expect, it } from 'vitest';
import { resolveSessionFileOpenTarget } from '../src/lib/session-file-open-target';

const WORKSPACE = '/Users/dev/project';

describe('resolveSessionFileOpenTarget', () => {
  describe('a path that came from the file index', () => {
    // Every one of these is a legal filename, and every one of them used to be
    // rewritten into a path the machine could not find, because the file tree,
    // quick open and the mobile browser all shared the markdown-href parser
    // with agent-written chat links.
    const untouched = [
      ['percent-encoding in the name', 'docs/report%20v2.md'],
      ['a percent sign in the name', 'assets/100%25.png'],
      ['a colon and digits at the end', 'logs/2024:30.txt'],
      ['a `worktrees/<uuid>/` segment of its own', 'fixtures/worktrees/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/case.txt'],
      ['a hash in the name', 'notes/draft#2.md'],
      ['a leading space', ' notes.md'],
    ] as const;

    for (const [description, filePath] of untouched) {
      it(`passes through ${description}`, () => {
        expect(
          resolveSessionFileOpenTarget({
            rawPath: filePath,
            pathKind: 'canonical',
            workspacePath: WORKSPACE,
          })
        ).toEqual({ filePath, fromMarkdownLink: false });
      });
    }

    it('carries an anchor the caller supplied rather than one parsed from the path', () => {
      expect(
        resolveSessionFileOpenTarget({
          rawPath: 'src/app.ts',
          pathKind: 'canonical',
          workspacePath: WORKSPACE,
          startLine: 42,
        })
      ).toEqual({ filePath: 'src/app.ts', startLine: 42, fromMarkdownLink: false });
    });
  });

  describe('an href an agent wrote', () => {
    it('splits a trailing line suffix off the path', () => {
      expect(
        resolveSessionFileOpenTarget({
          rawPath: 'src/app.ts:12',
          pathKind: 'markdown-href',
          workspacePath: WORKSPACE,
        })
      ).toMatchObject({
        filePath: 'src/app.ts',
        startLine: 12,
        fromMarkdownLink: true,
        lineSuffixFormat: 'colon',
      });
    });

    it('makes an absolute path inside the workspace relative to it', () => {
      expect(
        resolveSessionFileOpenTarget({
          rawPath: `${WORKSPACE}/src/app.ts`,
          pathKind: 'markdown-href',
          workspacePath: WORKSPACE,
        })
      ).toMatchObject({ filePath: 'src/app.ts' });
    });

    it('decodes percent-encoding, which is why an indexed path must not come through here', () => {
      expect(
        resolveSessionFileOpenTarget({
          rawPath: 'docs/report%20v2.md',
          pathKind: 'markdown-href',
          workspacePath: WORKSPACE,
        })
      ).toMatchObject({ filePath: 'docs/report v2.md' });
    });
  });
});
