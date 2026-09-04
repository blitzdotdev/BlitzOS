import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `/usr/local/bin/claude` and `/usr/local/bin/codex` are PATH shims. The image
 * puts /usr/local/bin ahead of /opt/blitz/npm/bin, so every terminal `claude`
 * or `codex` enters here first and the shim decides what the vendor CLI is
 * allowed to do before execing the vendor binary.
 *
 * BOTH CLIs UPDATE THEMSELVES, and that is intended: claude's version is what
 * decides which models the Lody composer can offer (docs/LODY-MODELS.md), so a
 * held version held the model list too. An update runs `npm install -g` into
 * NPM_CONFIG_PREFIX — /opt/blitz/npm, owned by uid 1000 — which rewrites the
 * copy the shim execs IN PLACE. The PATH order is what makes that safe rather
 * than shadowing, and it is asserted below.
 *
 * codex has no environment variable for the check: checked against
 * @openai/codex@0.147.0, `codex doctor --json` reports
 * `"check for update on startup": "true"` by default, and honours either value
 * passed as `-c check_for_update_on_startup=…`.
 *
 * packages/box/test/syntax.sh parses these same files, but it runs behind
 * smoke.sh and needs docker. These run everywhere.
 */

const shimPath = (name: string) =>
  fileURLToPath(new URL(`../../rootfs/usr/local/bin/${name}`, import.meta.url));

const shim = (name: string) => readFileSync(shimPath(name), "utf8");

describe("vendor CLI PATH shims", () => {
  it.each(["claude", "codex"])("%s execs the pinned binary, not the name again", (name) => {
    // /usr/local/bin comes first on PATH, so a bare `exec claude` would
    // re-enter this shim and loop until the box runs out of processes.
    expect(shim(name)).toContain(`exec /opt/blitz/npm/bin/${name} `);
  });

  it.each(["claude", "codex"])("%s is executable by everyone", (name) => {
    // The Dockerfile chmods these to 0755. A shim the runtime user cannot
    // execute is a terminal with no agent in it.
    expect(statSync(shimPath(name)).mode & 0o755).toBe(0o755);
  });

  it("leaves claude's auto-updater on", () => {
    // The flag used to be exported here and in three other places. It is gone:
    // holding the CLI version held the model list with it. Assert the absence,
    // so re-adding it anywhere in this shim is a test failure and not a quiet
    // regression back to a stale model picker.
    expect(shim("claude")).not.toContain("DISABLE_AUTOUPDATER");
  });

  it("leaves codex's startup update check on", () => {
    // Stated explicitly rather than left to codex's default, so a vendor
    // default flip cannot silently reverse the intent.
    expect(shim("codex")).toContain("-c check_for_update_on_startup=true");
  });

  it("puts codex's flag before the caller's arguments", () => {
    // codex takes `-c` more than once and the LAST one wins. The flag leads so
    // a caller keeps the last word — blitz-term's recipe path already passes
    // its own `-c model_reasoning_effort=…` after it.
    const line = shim("codex").split("\n").find((row) => row.startsWith("exec "));
    expect(line).toBe(
      'exec /opt/blitz/npm/bin/codex -c check_for_update_on_startup=true "$@"',
    );
  });
});
