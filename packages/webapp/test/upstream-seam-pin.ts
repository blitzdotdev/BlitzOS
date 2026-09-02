/**
 * The seam pin, in one place, because two suites now make the same claim.
 *
 * It was `lody-surface-tabs.test.tsx`'s local helper while seam patch 5 was the
 * only patch with a baseline to check against. Seam patch 15 patches two more
 * vendored files and makes the same claim about them, and a second copy of this
 * would be a second definition of what "inert" means.
 *
 * WHAT IT PROVES. With every new prop absent, a patched vendor file renders
 * byte-for-byte what upstream renders. Two claims carry that:
 *
 * 1. Each declared anchor is the line upstream really has at that number, so
 *    the tables in `BLITZ-PATCHES.md` describe this tree and not a remembered
 *    one.
 * 2. Upstream MINUS those lines is still a subsequence of the patched file.
 *    Every other line upstream wrote survives, in order — so the patch only
 *    ADDS, and the branches upstream takes with the new props absent are the
 *    branches it took before. An undeclared deletion, or a reworded line, fails
 *    with the first upstream line that could not be found.
 *
 * IT READS NOTHING BUT CHECKED-OUT FILES. Asking `git show <pin>:<path>` for the
 * pristine source works in a full clone and fails in CI: the subtree squash
 * carries the upstream paths at their own root, and a shallow clone may not
 * hold the object at all. The baselines are committed beside this file; see
 * `upstream-baseline/README.md` for provenance and how to refresh them.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const componentsDir = join(repoRoot, "vendor/lody/packages/components/src");
const baselineDir = join(here, "upstream-baseline");

/** One line the seam removes from upstream, by its line number in the pristine
 * file. The number is what makes an anchor unambiguous: `        )}` occurs
 * dozens of times in `session-tab-bar.tsx`, and "the first one" is not a
 * statement about anything. */
export type SeamAnchor = readonly [line: number, text: string];

const readLines = (path: string): string[] => readFileSync(path, "utf8").split("\n");

/**
 * Asserts one vendored file against its pristine upstream baseline.
 *
 * `vendorPath` is relative to `vendor/lody/packages/components/src`, and the
 * baseline is `upstream-baseline/<basename>.txt`.
 */
export function expectSeam(vendorPath: string, anchors: readonly SeamAnchor[]): void {
  const file = vendorPath.slice(vendorPath.lastIndexOf("/") + 1);
  const upstream = readLines(join(baselineDir, `${file}.txt`));
  const patched = readLines(join(componentsDir, vendorPath));
  const removed = new Set<number>();
  for (const [line, text] of anchors) {
    expect(upstream[line - 1], `${file}:${line} is the anchor BLITZ-PATCHES.md names`).toBe(text);
    removed.add(line);
  }
  expect(removed.size, "an anchor is declared twice").toBe(anchors.length);

  const kept = upstream.filter((_line, index) => !removed.has(index + 1));
  // Greedy is exact for a subsequence test: the earliest match never rules out
  // a later one, so a failure here is a line the patched file really lost.
  let cursor = 0;
  for (const line of kept) {
    while (cursor < patched.length && patched[cursor] !== line) cursor += 1;
    expect(
      cursor,
      `${file} no longer carries an upstream line the seam does not declare: ${JSON.stringify(line)}`,
    ).toBeLessThan(patched.length);
    cursor += 1;
  }
}

/** The vendored file's own text, for a claim about what the patch ADDED — the
 * half a subsequence check cannot make. */
export function readVendoredSource(vendorPath: string): string {
  return readFileSync(join(componentsDir, vendorPath), "utf8");
}
