import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { open, stat } from 'node:fs/promises';

import { computeLineCounts } from './diff-line-counts';

export type DiffWorkerTaskInput =
  | {
      readonly kind: 'line-count';
      readonly oldText: string | null;
      readonly newText: string | null;
    }
  | {
      readonly kind: 'turn-evidence';
      readonly oldText: string | null;
      readonly newText: string | null;
      readonly absolutePath: string;
    };

export type DiffWorkerTaskResult =
  | { readonly kind: 'line-count'; readonly lineCounts: [number, number] }
  | {
      readonly kind: 'turn-evidence';
      readonly lineCounts: [number, number];
      readonly newIsCurrent: boolean;
    };

export async function runDiffWorkerTask(input: DiffWorkerTaskInput): Promise<DiffWorkerTaskResult> {
  const lineCounts = computeLineCounts(input.oldText, input.newText);
  if (input.kind === 'line-count') return { kind: input.kind, lineCounts };
  return {
    kind: input.kind,
    lineCounts,
    newIsCurrent: await newSnapshotMatchesFile(input.absolutePath, input.newText),
  };
}

async function newSnapshotMatchesFile(
  absolutePath: string,
  newText: string | null
): Promise<boolean> {
  let file;
  try {
    file = await open(absolutePath, 'r');
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return newText === null;
    throw error;
  }
  try {
    if (newText === null) return false;
    const expectedBytes = Buffer.byteLength(newText, 'utf8');
    const before = await file.stat({ bigint: true });
    if (before.size !== BigInt(expectedBytes)) return false;

    const diskHash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(Math.max(expectedBytes, 1), 64 * 1024));
    let offset = 0;
    while (offset < expectedBytes) {
      const length = Math.min(buffer.byteLength, expectedBytes - offset);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead === 0) return false;
      diskHash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }

    const [after, pathAfter] = await Promise.all([
      file.stat({ bigint: true }),
      stat(absolutePath, { bigint: true }).catch((error: unknown) => {
        if (nodeErrorCode(error) === 'ENOENT') return null;
        throw error;
      }),
    ]);
    if (!pathAfter || !sameFileState(before, after) || !sameFileState(after, pathAfter)) {
      return false;
    }
    const snapshotHash = createHash('sha256').update(newText, 'utf8').digest();
    return diskHash.digest().equals(snapshotHash);
  } finally {
    await file.close();
  }
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}
