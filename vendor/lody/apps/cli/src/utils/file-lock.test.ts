import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let testHomeDir: string;
let originalLodyDataDir: string | undefined;

async function loadFileLockModule() {
  return await import('./file-lock');
}

beforeEach(() => {
  testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-home-'));
  originalLodyDataDir = process.env.LODY_DATA_DIR;
  process.env.LODY_DATA_DIR = path.join(testHomeDir, '.lody');
  vi.resetModules();
});

afterEach(() => {
  if (originalLodyDataDir === undefined) {
    delete process.env.LODY_DATA_DIR;
  } else {
    process.env.LODY_DATA_DIR = originalLodyDataDir;
  }
  try {
    fs.rmSync(testHomeDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('withFileLock', () => {
  it('executes fn while holding the lock and releases afterwards', async () => {
    const { withFileLock } = await loadFileLockModule();

    const lockName = 'basic-lock';
    const locksDir = path.join(testHomeDir, '.lody', 'locks');
    const lockPath = path.join(locksDir, `${lockName}.lock`);

    const result = await withFileLock(lockName, async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number };
      expect(content.pid).toBe(process.pid);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(fs.existsSync(locksDir)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('sanitizes lock name for filesystem safety', async () => {
    const { withFileLock } = await loadFileLockModule();

    const lockName = 'weird:/\\name*?';
    const safeName = lockName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const locksDir = path.join(testHomeDir, '.lody', 'locks');
    const lockPath = path.join(locksDir, `${safeName}.lock`);

    await withFileLock(lockName, async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('removes stale locks and reacquires them', async () => {
    const { withFileLock } = await loadFileLockModule();

    const lockName = 'stale';
    const locksDir = path.join(testHomeDir, '.lody', 'locks');
    fs.mkdirSync(locksDir, { recursive: true });

    const lockPath = path.join(locksDir, `${lockName}.lock`);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999999,
        timestamp: Date.now() - 31 * 60 * 1000,
      })
    );

    const value = await withFileLock(
      lockName,
      async () => {
        expect(fs.existsSync(lockPath)).toBe(true);
        const content = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number };
        expect(content.pid).toBe(process.pid);
        return 42;
      },
      { retryDelay: 1, timeout: 5000 }
    );

    expect(value).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('times out when an existing lock is held by a live pid', async () => {
    const { withFileLock } = await loadFileLockModule();

    const lockName = 'busy';
    const locksDir = path.join(testHomeDir, '.lody', 'locks');
    fs.mkdirSync(locksDir, { recursive: true });

    const lockPath = path.join(locksDir, `${lockName}.lock`);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        timestamp: Date.now(),
      })
    );

    await expect(
      withFileLock(lockName, async () => 'never', {
        timeout: 200,
        retryDelay: 5,
        maxRetryDelay: 10,
      })
    ).rejects.toThrow(/Failed to acquire lock/);

    expect(fs.existsSync(lockPath)).toBe(true);
  });
});

describe('cleanupStaleLocks', () => {
  it('removes stale or invalid lock files but keeps valid ones', async () => {
    const { cleanupStaleLocks } = await loadFileLockModule();

    const locksDir = path.join(testHomeDir, '.lody', 'locks');
    fs.mkdirSync(locksDir, { recursive: true });

    const stalePath = path.join(locksDir, 'old.lock');
    const invalidPath = path.join(locksDir, 'invalid.lock');
    const validPath = path.join(locksDir, 'valid.lock');

    fs.writeFileSync(
      stalePath,
      JSON.stringify({
        pid: 999999,
        timestamp: Date.now() - 31 * 60 * 1000,
      })
    );
    fs.writeFileSync(invalidPath, 'not-json');
    fs.writeFileSync(
      validPath,
      JSON.stringify({
        pid: process.pid,
        timestamp: Date.now(),
      })
    );

    cleanupStaleLocks();

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(invalidPath)).toBe(false);
    expect(fs.existsSync(validPath)).toBe(true);
  });

  it('does not throw if the locks directory is missing', async () => {
    const { cleanupStaleLocks } = await loadFileLockModule();

    expect(() => cleanupStaleLocks()).not.toThrow();
  });
});
