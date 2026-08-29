import { describe, expect, it } from 'vitest';

import {
  describeSessionDiffSnapshot,
  getSessionDiffErrorMessage,
  serializeSessionDiffError,
} from '../src/lib/session-diff-diagnostics';
import {
  isBinaryBaseVersionUnavailableError,
  isFileNotFoundError,
  isTagNotFoundError,
} from '../src/components/sessions/session-conversation-diff-types';

describe('session diff diagnostics', () => {
  it('summarizes text snapshots by length instead of raw content', () => {
    expect(describeSessionDiffSnapshot({ kind: 'text', text: 'hello world' })).toEqual({
      kind: 'text',
      textLength: 11,
    });
  });

  it('serializes errors with stable metadata', () => {
    const error = new Error('boom');
    const serialized = serializeSessionDiffError(error);

    expect(serialized).toMatchObject({
      name: 'Error',
      message: 'boom',
    });
    expect(serialized.stack).toEqual(expect.any(String));
    expect(getSessionDiffErrorMessage(error)).toBe('boom');
  });

  it('keeps missing tags distinct from missing files', () => {
    const tagError = Object.assign(new Error('Tag not found: turn:end'), {
      code: 'tag_not_found',
    });
    const fileError = Object.assign(new Error('File not found: src/new.ts'), {
      code: 'file_not_found',
    });

    expect(isTagNotFoundError(tagError)).toBe(true);
    expect(isFileNotFoundError(tagError)).toBe(false);
    expect(isFileNotFoundError(fileError)).toBe(true);
  });

  it('only classifies binary missing base versions as non-diffable binary snapshots', () => {
    const binaryBaseError = Object.assign(new Error('Base version unavailable'), {
      code: 'base_version_unavailable',
      fileType: 'binary',
      reason: 'missing baseVersion',
    });
    const missingCallbackError = Object.assign(new Error('Base version unavailable'), {
      code: 'base_version_unavailable',
      fileType: 'text',
      reason: 'getFileAtBaseCommit callback is not configured',
    });

    expect(isBinaryBaseVersionUnavailableError(binaryBaseError)).toBe(true);
    expect(isBinaryBaseVersionUnavailableError(missingCallbackError)).toBe(false);
  });
});
