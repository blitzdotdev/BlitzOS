import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizeSessionFileSourcePath } from '../src/lib/message-handler';

describe('normalizeSessionFileSourcePath', () => {
  it('persists Windows workspace-relative paths with canonical separators', () => {
    expect(normalizeSessionFileSourcePath('artifacts\\nested\\result.html', path.win32.sep)).toBe(
      'artifacts/nested/result.html'
    );
  });

  it('leaves canonical workspace-relative paths unchanged', () => {
    expect(normalizeSessionFileSourcePath('artifacts/result.html', path.posix.sep)).toBe(
      'artifacts/result.html'
    );
  });

  it('preserves a literal backslash in a POSIX file name', () => {
    expect(normalizeSessionFileSourcePath('artifacts/result\\draft.html', path.posix.sep)).toBe(
      'artifacts/result\\draft.html'
    );
  });
});
