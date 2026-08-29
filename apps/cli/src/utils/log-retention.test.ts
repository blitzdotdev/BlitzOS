import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupExpiredLogs, LODY_LOG_RETENTION_MS } from './log-retention';

const tempDirs: string[] = [];

function createTempLogDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-log-retention-'));
  tempDirs.push(dir);
  return dir;
}

function touchWithMtime(filePath: string, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'log', 'utf8');
  const mtime = new Date(mtimeMs);
  fs.utimesSync(filePath, mtime, mtime);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('cleanupExpiredLogs', () => {
  it('removes managed log files older than the retention window', () => {
    const now = Date.UTC(2026, 3, 5, 12, 0, 0);
    const logDir = createTempLogDir();

    const oldLog = path.join(logDir, '2026-03-20.log');
    const oldJsonl = path.join(logDir, 'acp', '20260320', 'session.jsonl');
    const recentLog = path.join(logDir, '2026-04-05.log');
    const oldText = path.join(logDir, 'notes.txt');

    touchWithMtime(oldLog, now - LODY_LOG_RETENTION_MS - 1);
    touchWithMtime(oldJsonl, now - LODY_LOG_RETENTION_MS - 1);
    touchWithMtime(recentLog, now - 60_000);
    touchWithMtime(oldText, now - LODY_LOG_RETENTION_MS - 1);

    const removed = cleanupExpiredLogs(logDir, { now });

    expect(removed).toBe(2);
    expect(fs.existsSync(oldLog)).toBe(false);
    expect(fs.existsSync(oldJsonl)).toBe(false);
    expect(fs.existsSync(recentLog)).toBe(true);
    expect(fs.existsSync(oldText)).toBe(true);
    expect(fs.existsSync(path.join(logDir, 'acp', '20260320'))).toBe(false);
  });
});
