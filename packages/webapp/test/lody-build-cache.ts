import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

const DEFAULT_WAIT_MS = 900_000;
const STALE_UNOWNED_LOCK_MS = 60_000;

interface LockOwner {
  pid: number;
  startTime: string | null;
  hostname: string;
  fingerprint: string;
}

export interface AtomicBuildCacheOptions {
  cachePath: string;
  validate(path: string): boolean;
  build(stagingPath: string): Promise<void> | void;
  waitMs?: number;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Read field 22 from Linux's /proc/<pid>/stat without splitting the comm field. */
function linuxProcessStartTime(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  const commEnd = stat.lastIndexOf(")");
  const fieldsAfterComm =
    commEnd === -1
      ? []
      : stat
          .slice(commEnd + 1)
          .trim()
          .split(/\s+/u);
  const startTime = fieldsAfterComm[19];
  if (startTime === undefined || !/^\d+$/u.test(startTime)) {
    throw new Error(`could not read process start time from /proc/${pid}/stat`);
  }
  return startTime;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return false;
    if (hasErrorCode(error, "EPERM")) return true;
    throw error;
  }
}

function parseLockOwner(source: string): LockOwner | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    !("startTime" in value) ||
    (typeof value.startTime !== "string" && value.startTime !== null) ||
    !("hostname" in value) ||
    typeof value.hostname !== "string" ||
    value.hostname === "" ||
    !("fingerprint" in value) ||
    typeof value.fingerprint !== "string" ||
    value.fingerprint === ""
  ) {
    return null;
  }
  return {
    pid: value.pid,
    startTime: value.startTime,
    hostname: value.hostname,
    fingerprint: value.fingerprint,
  };
}

function unownedLockIsStale(lockPath: string): boolean {
  const metadata = statSync(lockPath, { throwIfNoEntry: false });
  return (
    metadata !== undefined &&
    Date.now() - metadata.mtimeMs > STALE_UNOWNED_LOCK_MS
  );
}

function ownerIsGone(lockPath: string): boolean {
  let source: string;
  try {
    source = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    return unownedLockIsStale(lockPath);
  }
  const owner = parseLockOwner(source);
  if (owner === null) return unownedLockIsStale(lockPath);
  if (owner.hostname !== hostname()) return false;
  if (!processIsAlive(owner.pid)) return true;

  if (process.platform !== "linux") {
    // Non-Linux platforms have no portable process birth identifier. PID-only
    // liveness can therefore wait on a reused PID until the normal deadline.
    return false;
  }
  if (owner.startTime === null) return unownedLockIsStale(lockPath);
  const currentStartTime = linuxProcessStartTime(owner.pid);
  return currentStartTime === null || currentStartTime !== owner.startTime;
}

function createOwner(): LockOwner {
  const startTime =
    process.platform === "linux" ? linuxProcessStartTime(process.pid) : null;
  if (process.platform === "linux" && startTime === null) {
    throw new Error(
      `could not read this process from /proc/${process.pid}/stat`,
    );
  }
  return {
    pid: process.pid,
    startTime,
    hostname: hostname(),
    fingerprint: randomBytes(16).toString("hex"),
  };
}

function tryAcquireLock(lockPath: string): string | null {
  const ownerSource = `${JSON.stringify(createOwner())}\n`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return null;
    throw error;
  }

  try {
    writeFileSync(descriptor, ownerSource);
  } finally {
    closeSync(descriptor);
  }
  return ownerSource;
}

function reclaimStaleLock(lockPath: string): boolean {
  const tombstone =
    `${lockPath}.stale.${process.pid}.` + randomBytes(8).toString("hex");
  try {
    renameSync(lockPath, tombstone);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  rmSync(tombstone, { recursive: true, force: true });
  return true;
}

function releaseLock(lockPath: string, ownerSource: string): void {
  let currentSource: string;
  try {
    currentSource = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (currentSource !== ownerSource) return;
  try {
    rmSync(lockPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Resolve one fingerprint-keyed cache entry under an atomic interprocess lock.
 * Every waiter revalidates only after acquiring the lock, and incomplete work
 * stays in a unique sibling until one validated directory rename.
 */
export async function resolveAtomicBuildCache(
  options: AtomicBuildCacheOptions,
): Promise<string> {
  const lockPath = `${options.cachePath}.lock`;
  const parent = dirname(options.cachePath);
  mkdirSync(parent, { recursive: true });
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);

  for (;;) {
    const ownerSource = tryAcquireLock(lockPath);
    if (ownerSource === null) {
      if (ownerIsGone(lockPath)) {
        if (!reclaimStaleLock(lockPath)) await pause(50);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for Lody build cache lock ${lockPath}`,
        );
      }
      await pause(50);
      continue;
    }

    try {
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
    } finally {
      releaseLock(lockPath, ownerSource);
    }
  }
}
