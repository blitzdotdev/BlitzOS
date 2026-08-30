import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPidFileRecord, removePidFile, writePidFile } from './daemon-shared';

const tempDirs: string[] = [];

function createPidPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-daemon-owner-'));
  tempDirs.push(dir);
  return path.join(dir, 'daemon.pid');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('daemon PID ownership', () => {
  it('atomically replaces stale diagnostics after Host ownership is acquired', () => {
    const filePath = createPidPath();
    writePidFile(101, 'stale', 'stale-token', filePath);
    const current = writePidFile(202, 'current', 'current-token', filePath);

    expect(readPidFileRecord(filePath)).toEqual(current);
  });

  it('does not let a stale owner delete a replacement owner record', () => {
    const filePath = createPidPath();
    const stale = writePidFile(101, 'stale', 'stale-token', filePath);
    expect(removePidFile(stale, filePath)).toBe(true);
    const replacement = writePidFile(202, 'replacement', 'replacement-token', filePath);

    expect(removePidFile(stale, filePath)).toBe(false);
    expect(readPidFileRecord(filePath)).toEqual(replacement);
  });

  it('rejects records without the full v1 identity, including legacy numeric files', () => {
    const filePath = createPidPath();
    fs.writeFileSync(filePath, '303', 'utf8');
    expect(readPidFileRecord(filePath)).toBeNull();

    fs.writeFileSync(filePath, JSON.stringify({ version: 1, pid: 303 }), 'utf8');
    expect(readPidFileRecord(filePath)).toBeNull();
  });
});
