import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every script the image EXECS directly must carry the execute bit.
 *
 * WHY THIS EXISTS. `blitz-credential-refresh` shipped 0644 once. Nothing here
 * noticed, all three gates passed, and the failure surfaced only in the box
 * image build, as `s6-applyuidgid: fatal: unable to exec
 * /usr/local/libexec/blitz-credential-refresh: Permission denied`. That is a
 * container boot away from the mistake — this is one `statSync` away.
 *
 * ONLY THESE TWO DIRECTORIES. `s6-rc.d/*` `run` and `up` files are 0644 on
 * purpose: s6 reads them and runs them through its own launcher, so an execute
 * bit there would say something this repo does not mean.
 */
const rootfs = (path: string) =>
  fileURLToPath(new URL(`../../rootfs/${path}`, import.meta.url));

const EXECUTED_DIRECTORIES = ["usr/local/bin", "usr/local/libexec"] as const;

const scripts = EXECUTED_DIRECTORIES.flatMap((directory) =>
  readdirSync(rootfs(directory)).map((name) => [`${directory}/${name}`] as const),
);

describe("scripts the image execs directly", () => {
  it("finds every directory this suite claims to cover", () => {
    // A renamed directory would leave this suite asserting about nothing.
    expect(scripts.length).toBeGreaterThan(EXECUTED_DIRECTORIES.length);
  });

  it.each(scripts)("%s is executable", (path) => {
    expect(statSync(rootfs(path)).mode & 0o111).toBe(0o111);
  });
});
