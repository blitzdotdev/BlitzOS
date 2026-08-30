import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runDiffWorkerTask } from './diff-worker-task';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('turn-evidence diff worker task', () => {
  it('proves matching disk text and rejects a size mismatch', async () => {
    const filePath = createFile('evidence.txt', 'current\ntext\n');

    await expect(
      runDiffWorkerTask({
        kind: 'turn-evidence',
        oldText: 'old\n',
        newText: 'current\ntext\n',
        absolutePath: filePath,
      })
    ).resolves.toEqual({ kind: 'turn-evidence', lineCounts: [2, 1], newIsCurrent: true });

    writeFileSync(filePath, 'x'.repeat(2 * 1024 * 1024));
    await expect(
      runDiffWorkerTask({
        kind: 'turn-evidence',
        oldText: 'old\n',
        newText: 'x',
        absolutePath: filePath,
      })
    ).resolves.toMatchObject({ kind: 'turn-evidence', newIsCurrent: false });
  });

  it('distinguishes a missing file from an existing file for deletions', async () => {
    const directory = createTempDirectory();
    const missingPath = path.join(directory, 'missing.txt');

    await expect(
      runDiffWorkerTask({
        kind: 'turn-evidence',
        oldText: 'removed\n',
        newText: null,
        absolutePath: missingPath,
      })
    ).resolves.toMatchObject({ kind: 'turn-evidence', newIsCurrent: true });

    writeFileSync(missingPath, 'still here');
    await expect(
      runDiffWorkerTask({
        kind: 'turn-evidence',
        oldText: 'removed\n',
        newText: null,
        absolutePath: missingPath,
      })
    ).resolves.toMatchObject({ kind: 'turn-evidence', newIsCurrent: false });
  });
});

function createFile(filename: string, contents: string): string {
  const filePath = path.join(createTempDirectory(), filename);
  writeFileSync(filePath, contents);
  return filePath;
}

function createTempDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-diff-worker-task-'));
  tempDirectories.push(directory);
  return directory;
}
