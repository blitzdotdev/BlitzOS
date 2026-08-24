import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Pins the Remote Control service. The feature has been lost twice: once when
 * it shipped as a bootstrap-emitted tmux session that owned the box's tmux
 * server, and again when that emission was parked. Each rule below is a
 * measured failure, not a style preference. */

const serviceDirectory = new URL(
  "../../rootfs/etc/s6-overlay/s6-rc.d/remote-control/",
  import.meta.url,
);

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, serviceDirectory)), "utf8");
}

const runScript = read("run");

/** The run script explains each rule in a comment, so a naive match on the
 * whole file finds the prose rather than the command. Absence claims are made
 * against the executable lines only. */
const runCode = runScript
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("remote-control s6 service", () => {
  it("is a longrun registered in the user bundle", () => {
    expect(read("type").trim()).toBe("longrun");
    expect(read("dependencies.d/register")).toBeDefined();
    const bundleEntry = fileURLToPath(
      new URL("../user/contents.d/remote-control", serviceDirectory),
    );
    // An unregistered service never starts, and nothing else would say so.
    expect(statSync(bundleEntry).isFile()).toBe(true);
  });

  it("detects the login by polling the credentials file, never by running claude", () => {
    // A logged-out `claude rc` rewrites ~/.claude.json, which erased logins a
    // member had just completed in a tab. The guard must not execute claude.
    expect(runCode).toMatch(/\.claude\/\.credentials\.json/u);
    // "claude" appears in the guard as a path segment; what must be absent is
    // an invocation of the binary.
    const guard = runCode.slice(0, runCode.indexOf("login present"));
    expect(guard).not.toMatch(/bin\/claude|claude rc/u);
  });

  it("waits without a deadline", () => {
    // A member may log in an hour after the box boots; a loop that gave up
    // would need a second mechanism to notice.
    expect(runCode).toMatch(/while \[ ! -s "\$credentials" \]/u);
  });

  it("bypasses the PATH shim and strips injected tokens", () => {
    // Remote Control rejects CLAUDE_CODE_OAUTH_TOKEN outright: "Long-lived
    // tokens are limited to inference-only". /usr/local/bin/claude injects it.
    expect(runCode).toMatch(/\/opt\/blitz\/npm\/bin\/claude rc/u);
    expect(runCode).not.toMatch(/\/usr\/local\/bin\/claude/u);
    for (const variable of [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
    ]) {
      expect(runCode).toMatch(new RegExp(`-u ${variable}`, "u"));
    }
  });

  it("supplies a pty without involving tmux", () => {
    // Remote Control opens an interactive session. tmux would make this
    // service the owner of the box's tmux server, which is what broke tabs
    // when the feature lived in bootstrap.
    expect(runCode).toMatch(/\/usr\/bin\/script -qec/u);
    expect(runCode).not.toMatch(/tmux/u);
  });

  it("runs as the box user, not root", () => {
    expect(runCode).toMatch(/s6-setuidgid blitz/u);
  });
});
