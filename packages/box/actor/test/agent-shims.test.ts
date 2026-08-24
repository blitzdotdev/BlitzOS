import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `/usr/local/bin/claude` and `/usr/local/bin/codex` are PATH shims. The image
 * puts /usr/local/bin ahead of /opt/blitz/npm/bin, so every terminal `claude`
 * or `codex` enters here first and the shim decides what the vendor CLI is
 * allowed to do before execing the pinned binary.
 *
 * What they hold is the version pin. Both CLIs offer to update themselves, and
 * NPM_CONFIG_PREFIX is /opt/blitz/npm, owned by uid 1000 — so taking the offer
 * overwrites the pinned copy in place and the box quietly stops running the
 * version it was built with. Nothing at runtime reports that.
 *
 * The two guards are different because the vendors are different. claude reads
 * `DISABLE_AUTOUPDATER`. codex has no environment variable at all: checked
 * against @openai/codex@0.147.0, the pinned version, `codex doctor --json`
 * reports `"check for update on startup": "true"` by default and `"false"`
 * only with `-c check_for_update_on_startup=false`.
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

  it("keeps claude's auto-updater off", () => {
    expect(shim("claude")).toContain("DISABLE_AUTOUPDATER=1");
    expect(shim("claude")).toContain("export DISABLE_AUTOUPDATER");
  });

  it("keeps codex's startup update check off", () => {
    // Without the flag, codex's first screen offers "Update available!" and
    // the update path runs `npm install -g @openai/codex` over the pin.
    expect(shim("codex")).toContain("-c check_for_update_on_startup=false");
  });

  it("puts codex's flag before the caller's arguments", () => {
    // codex takes `-c` more than once and the LAST one wins. The flag leads so
    // a caller keeps the last word — blitz-term's recipe path already passes
    // its own `-c model_reasoning_effort=…` after it.
    const line = shim("codex").split("\n").find((row) => row.startsWith("exec "));
    expect(line).toBe(
      'exec /opt/blitz/npm/bin/codex -c check_for_update_on_startup=false "$@"',
    );
  });
});
