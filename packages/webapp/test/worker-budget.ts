/**
 * How many vitest workers this machine can afford right now.
 *
 * WHY MEMORY AND NOT ONLY CORES. Three suites import the vendored Lody
 * renderer, and a forked worker holding that graph — Monaco, three, mermaid,
 * shiki, loro's WASM — plus a `lody` daemon runs to a gigabyte. Four of those
 * on a box with a gigabyte free gets the run SIGKILLed: exit code 137, no
 * failing test, just `Killed`.
 *
 * WHY THE CGROUP AND NOT ONLY `os.freemem()`. A box is one flat memory pool to
 * `freemem`, but its user work runs under a cgroup ceiling
 * (`docs/MEMORY-BOUNDARY.md`): `blitz-user.slice` throttles at `memory.high`,
 * about 1.5 GB below the machine's RAM, and kills at `memory.max`. Measured on
 * a cx33 on 2026-09-02: `freemem` said 4.4 GB while the slice had 2.6 GB left
 * under its throttle line, so a run sized by `freemem` alone took four workers
 * and drove the whole box into reclaim. The tightest headroom along the cgroup
 * ancestry is the number that decides whether a worker fits.
 *
 * Both readings are taken ONCE, when vitest loads its config. A run that
 * starts first and is then squeezed by a second one still cannot see it; what
 * this fixes is the second run, which now sees what the first one left.
 */
import { readFileSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";
import { join } from "node:path";

/** Measured footprint of one worker that has imported the vendored renderer,
 * rounded up to a round number. */
export const LODY_WORKER_BYTES = 1_073_741_824;

/** The cgroup v2 mount every Linux box has; a non-Linux dev machine has none,
 * and every read below then answers null. */
export const CGROUP_MOUNT = "/sys/fs/cgroup";

/** Reads one file, or null when it is absent or unreadable. Injected so the
 * ancestry walk can be tested against a directory tree instead of the kernel. */
export type FileReader = (path: string) => string | null;

export const readFileOrNull: FileReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** One `memory.high` or `memory.max` value: a byte count, or null for `max`
 * (no ceiling) and for anything that is not a number. */
export function parseMemoryKnob(text: string | null): number | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "max" || trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The unified-hierarchy path from `/proc/self/cgroup` — the `0::` line — or
 * null when there is none (cgroup v1 only, or not Linux). */
export function parseSelfCgroupPath(text: string | null): string | null {
  if (text === null) return null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("0::")) continue;
    const path = trimmed.slice("0::".length);
    return path === "" ? "/" : path;
  }
  return null;
}

/** Every cgroup from the leaf up to and including the root, leaf first. */
export function cgroupAncestry(selfPath: string): string[] {
  const parts = selfPath.split("/").filter((part) => part !== "");
  const paths: string[] = [];
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    paths.push(`/${parts.slice(0, depth).join("/")}`);
  }
  return paths;
}

/**
 * The tightest memory headroom along the ancestry: for each cgroup with a
 * ceiling, the lower of `memory.high` and `memory.max` minus `memory.current`;
 * the minimum of those. Null when no ancestor has a ceiling at all, which is
 * what a flat box (unprivileged container, dev workspace) reports, and what
 * a non-Linux machine reports because nothing can be read.
 *
 * `memory.high` counts as a ceiling although it only throttles: a run that
 * crosses it does not die, it makes the whole box crawl, and a test run is
 * not worth that.
 */
export function cgroupMemoryHeadroom(
  selfPath: string | null,
  readFile: FileReader,
  mount: string = CGROUP_MOUNT,
): number | null {
  if (selfPath === null) return null;
  let headroom: number | null = null;
  for (const path of cgroupAncestry(selfPath)) {
    const dir = join(mount, path);
    const high = parseMemoryKnob(readFile(join(dir, "memory.high")));
    const max = parseMemoryKnob(readFile(join(dir, "memory.max")));
    const ceiling = high === null ? max : max === null ? high : Math.min(high, max);
    if (ceiling === null) continue;
    const current = parseMemoryKnob(readFile(join(dir, "memory.current")));
    if (current === null) continue;
    const room = Math.max(0, ceiling - current);
    headroom = headroom === null ? room : Math.min(headroom, room);
  }
  return headroom;
}

export interface WorkerBudgetInputs {
  /** `os.availableParallelism()`: the ceiling cores impose. */
  cores: number;
  /** `os.freemem()`: what the whole machine has available. */
  freeBytes: number;
  /** `cgroupMemoryHeadroom(...)`: what the enclosing cgroups have left, or
   * null when none has a ceiling. */
  cgroupHeadroomBytes: number | null;
  /** The footprint one worker is budgeted at. */
  workerBytes: number;
}

/** Never fewer than one worker: a box that cannot fit one still has to run
 * the suite, and vitest needs a worker to do it. */
export function workerBudget(inputs: WorkerBudgetInputs): number {
  const budgetBytes =
    inputs.cgroupHeadroomBytes === null
      ? inputs.freeBytes
      : Math.min(inputs.freeBytes, inputs.cgroupHeadroomBytes);
  const byMemory = Math.floor(budgetBytes / inputs.workerBytes);
  return Math.max(1, Math.min(inputs.cores, byMemory));
}

/** The number `vite.config.ts` hands to `test.maxWorkers`. */
export function lodyAwareWorkerCount(readFile: FileReader = readFileOrNull): number {
  return workerBudget({
    cores: availableParallelism(),
    freeBytes: freemem(),
    cgroupHeadroomBytes: cgroupMemoryHeadroom(
      parseSelfCgroupPath(readFile("/proc/self/cgroup")),
      readFile,
    ),
    workerBytes: LODY_WORKER_BYTES,
  });
}
