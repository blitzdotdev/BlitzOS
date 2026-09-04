import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const DEFAULT_WAIT_MS = 900_000;
const STALE_UNOWNED_LOCK_MS = 60_000;

export interface AtomicBuildCacheOptions {
  cachePath: string;
  validate(path: string): boolean;
  build(stagingPath: string): Promise<void> | void;
  waitMs?: number;
}

function ownerIsGone(lockPath: string): boolean {
  try {
    const owner = Number.parseInt(
      readFileSync(join(lockPath, "pid"), "utf8"),
      10,
    );
    if (!Number.isInteger(owner) || owner <= 0) return true;
    try {
      process.kill(owner, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    const heldSince =
      statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    return Date.now() - heldSince > STALE_UNOWNED_LOCK_MS;
  }
}

const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Resolve one fingerprint-keyed cache entry under an interprocess mkdir lock.
 * The cache is never inspected before the caller owns the lock, and incomplete
 * work is confined to a unique sibling until one validated directory rename.
 */
export async function resolveAtomicBuildCache(
  options: AtomicBuildCacheOptions,
): Promise<string> {
  const lockPath = `${options.cachePath}.lock`;
  const parent = dirname(options.cachePath);
  mkdirSync(parent, { recursive: true });
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);

  for (;;) {
    let ownsLock = false;
    try {
      mkdirSync(lockPath);
      ownsLock = true;
      writeFileSync(join(lockPath, "pid"), `${process.pid}\n`);
      if (options.validate(options.cachePath)) return options.cachePath;

      const staging = mkdtempSync(
        join(parent, `.${basename(options.cachePath)}.stage-`),
      );
      try {
        await options.build(staging);
        if (!options.validate(staging)) {
          throw new Error("staged Lody build cache failed validation");
        }
        rmSync(options.cachePath, { recursive: true, force: true });
        renameSync(staging, options.cachePath);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
      return options.cachePath;
    } catch (error) {
      if (ownsLock) throw error;
      if (existsSync(lockPath) && ownerIsGone(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for Lody build cache lock ${lockPath}`,
        );
      }
      await pause(50);
    } finally {
      if (ownsLock) rmSync(lockPath, { recursive: true, force: true });
    }
  }
}
