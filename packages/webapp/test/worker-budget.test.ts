/**
 * The vitest worker budget against a fake cgroup tree.
 *
 * The numbers are the ones read on the blitzos-bugs box (cx33, 8 GB) on
 * 2026-09-02, when `os.freemem()` alone sized a run at four workers while the
 * user slice had room for two: root max 7590641664 / current 4166422528,
 * `blitz-user.slice` high 6529482752 max 7053770752 / current 3919224832,
 * `lody.scope` unlimited / current 3629993984.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cgroupAncestry,
  cgroupMemoryHeadroom,
  parseMemoryKnob,
  parseSelfCgroupPath,
  readFileOrNull,
  workerBudget,
} from "./worker-budget.js";

const GIB = 1_073_741_824;

describe("parseMemoryKnob", () => {
  it("reads a byte count", () => {
    expect(parseMemoryKnob("6529482752\n")).toBe(6529482752);
  });
  it("treats max, blanks and garbage as no ceiling", () => {
    expect(parseMemoryKnob("max\n")).toBeNull();
    expect(parseMemoryKnob("")).toBeNull();
    expect(parseMemoryKnob("lots")).toBeNull();
    expect(parseMemoryKnob(null)).toBeNull();
  });
});

describe("parseSelfCgroupPath", () => {
  it("takes the unified-hierarchy line and ignores v1 lines", () => {
    expect(parseSelfCgroupPath("1:memory:/old\n0::/blitz-user.slice/lody.scope\n")).toBe(
      "/blitz-user.slice/lody.scope",
    );
  });
  it("names the root when the process sits in it", () => {
    expect(parseSelfCgroupPath("0::/\n")).toBe("/");
  });
  it("answers null without a unified line, and without a file", () => {
    expect(parseSelfCgroupPath("1:memory:/only-v1\n")).toBeNull();
    expect(parseSelfCgroupPath(null)).toBeNull();
  });
});

describe("cgroupAncestry", () => {
  it("walks leaf first up to the root, root included", () => {
    expect(cgroupAncestry("/blitz-user.slice/lody.scope")).toEqual([
      "/blitz-user.slice/lody.scope",
      "/blitz-user.slice",
      "/",
    ]);
    expect(cgroupAncestry("/")).toEqual(["/"]);
  });
});

describe("cgroupMemoryHeadroom", () => {
  let mount = "";
  afterEach(() => {
    if (mount !== "") rmSync(mount, { recursive: true, force: true });
    mount = "";
  });

  function cgroup(path: string, knobs: Record<string, string>): void {
    const dir = join(mount, path);
    mkdirSync(dir, { recursive: true });
    for (const [name, value] of Object.entries(knobs)) {
      writeFileSync(join(dir, name), `${value}\n`);
    }
  }

  it("takes the tightest ceiling along the ancestry, memory.high included", () => {
    mount = mkdtempSync(join(tmpdir(), "cg-"));
    cgroup("/", { "memory.max": "7590641664", "memory.high": "max", "memory.current": "4166422528" });
    cgroup("/blitz-user.slice", {
      "memory.max": "7053770752",
      "memory.high": "6529482752",
      "memory.current": "3919224832",
    });
    cgroup("/blitz-user.slice/lody.scope", {
      "memory.max": "max",
      "memory.high": "max",
      "memory.current": "3629993984",
    });
    // root: 7590641664 - 4166422528 = 3424219136; user slice under its
    // throttle line: 6529482752 - 3919224832 = 2610257920; lody.scope: none.
    expect(cgroupMemoryHeadroom("/blitz-user.slice/lody.scope", readFileOrNull, mount)).toBe(
      2610257920,
    );
  });

  it("answers null on a flat box where nothing has a ceiling", () => {
    mount = mkdtempSync(join(tmpdir(), "cg-"));
    cgroup("/", { "memory.current": "1000" });
    cgroup("/leaf", { "memory.max": "max", "memory.high": "max", "memory.current": "10" });
    expect(cgroupMemoryHeadroom("/leaf", readFileOrNull, mount)).toBeNull();
  });

  it("skips a level whose files are missing rather than failing", () => {
    mount = mkdtempSync(join(tmpdir(), "cg-"));
    cgroup("/", {});
    cgroup("/a", { "memory.max": "5000", "memory.current": "1000" });
    cgroup("/a/b", { "memory.max": "3000" }); // no memory.current: unreadable level
    expect(cgroupMemoryHeadroom("/a/b", readFileOrNull, mount)).toBe(4000);
  });

  it("never reports negative headroom for a cgroup already over its line", () => {
    mount = mkdtempSync(join(tmpdir(), "cg-"));
    cgroup("/", { "memory.high": "1000", "memory.current": "1500" });
    expect(cgroupMemoryHeadroom("/", readFileOrNull, mount)).toBe(0);
  });

  it("answers null without a cgroup path (not Linux, or v1 only)", () => {
    expect(cgroupMemoryHeadroom(null, () => null)).toBeNull();
  });
});

describe("workerBudget", () => {
  it("sizes by the cgroup when it is tighter than freemem — the bugs-box case", () => {
    expect(
      workerBudget({
        cores: 4,
        freeBytes: 4375400 * 1024,
        cgroupHeadroomBytes: 2610257920,
        workerBytes: GIB,
      }),
    ).toBe(2);
  });
  it("falls back to freemem on a flat box", () => {
    expect(
      workerBudget({ cores: 4, freeBytes: 4.5 * GIB, cgroupHeadroomBytes: null, workerBytes: GIB }),
    ).toBe(4);
  });
  it("is capped by cores", () => {
    expect(
      workerBudget({ cores: 2, freeBytes: 16 * GIB, cgroupHeadroomBytes: 12 * GIB, workerBytes: GIB }),
    ).toBe(2);
  });
  it("never goes below one worker", () => {
    expect(
      workerBudget({ cores: 4, freeBytes: 3 * GIB, cgroupHeadroomBytes: 0, workerBytes: GIB }),
    ).toBe(1);
  });
});
