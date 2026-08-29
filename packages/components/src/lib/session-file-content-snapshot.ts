import type { CodeCollabContentUnavailableReason } from '@lody/shared';
import type { SessionFileOpenResult } from './session-file-provider';
import { getSessionFileUnavailableReasonLabel } from './session-file-provider-view-model';

export type SessionFileContentSnapshot =
  | { readonly kind: 'text'; readonly text: string; readonly truncated?: boolean }
  | { readonly kind: 'binary'; readonly bytes?: Uint8Array }
  | { readonly kind: 'missing' };

export type SessionFileContentLoadResult =
  | { readonly status: 'ready'; readonly snapshot: SessionFileContentSnapshot }
  | {
      readonly status: 'error';
      readonly message: string;
      readonly reason?: CodeCollabContentUnavailableReason;
    };

export function sessionFileOpenResultToContentLoadResult(
  result: SessionFileOpenResult
): SessionFileContentLoadResult {
  if (result.status === 'unavailable') {
    return {
      status: 'error',
      message: result.message ?? getSessionFileUnavailableReasonLabel(result.reason),
      reason: result.reason,
    };
  }

  switch (result.snapshot.kind) {
    case 'text':
      return {
        status: 'ready',
        snapshot: { kind: 'text', text: result.snapshot.text },
      };
    case 'binary':
      return {
        status: 'ready',
        snapshot: {
          kind: 'binary',
          ...(result.snapshot.bytes === undefined ? {} : { bytes: result.snapshot.bytes }),
        },
      };
    case 'unavailable':
      return {
        status: 'error',
        message:
          result.snapshot.message ?? getSessionFileUnavailableReasonLabel(result.snapshot.reason),
        reason: result.snapshot.reason,
      };
  }
  return assertNever(result.snapshot);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled session file open snapshot: ${String(value)}`);
}
