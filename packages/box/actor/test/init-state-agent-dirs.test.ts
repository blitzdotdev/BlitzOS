import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Regression pin for the agent config-dir ownership bug: blitz-init-state runs
 * as root, and `install -D` created ~/.claude and ~/.codex as root-owned dirs.
 * Claude Code persists its OAuth credential at ~/.claude/.credentials.json and
 * Codex writes state under ~/.codex, so a root-owned dir turned every login
 * into an EACCES persist failure ("Invalid code" retries, or a login that never
 * sticks). The dirs must be created with an explicit `install -d` that names
 * the box uid/gid, before the rule files are installed. */

const scriptPath = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-init-state", import.meta.url),
);

function scriptText(): string {
  return readFileSync(scriptPath, "utf8");
}

describe("blitz-init-state agent config dirs", () => {
  it("creates ~/.claude and ~/.codex with box ownership before installing rule files", () => {
    const text = scriptText();
    const dirLine = text.indexOf(
      'install -d -m 0755 -o "$uid" -g "$gid" "$state_dir/home/.claude" "$state_dir/home/.codex"',
    );
    expect(dirLine).toBeGreaterThan(-1);
    const claudeInstall = text.indexOf('"$state_dir/home/.claude/CLAUDE.md"');
    const codexInstall = text.indexOf('"$state_dir/home/.codex/AGENTS.md"');
    expect(claudeInstall).toBeGreaterThan(dirLine);
    expect(codexInstall).toBeGreaterThan(dirLine);
  });

  it("never lets install create the agent config dirs implicitly", () => {
    // `install -D` makes root-owned parents; the box user then cannot write
    // ~/.claude/.credentials.json. The rule files must be plain `install` into
    // dirs the line above already created with the right owner.
    expect(scriptText()).not.toMatch(/install\s+-D[^\n]*\.(claude|codex)\//u);
  });

  it("install -d repairs mode on a dir that already exists", () => {
    // Reboot path: a state dir written by an image that carried the bug has the
    // dirs already; install -d must apply attributes rather than skip. Runs
    // unprivileged, so ownership is asserted only as "current user works" —
    // the -o/-g transition itself needs root and is pinned textually above.
    const home = mkdtempSync(join(tmpdir(), "init-state-home-"));
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);
    const skel = join(home, "agent-rules.md");
    writeFileSync(skel, "# rules\n");
    const script = [
      `install -d -m 0700 -o ${uid} -g ${gid} "${home}/.claude"`,
      `install -d -m 0755 -o ${uid} -g ${gid} "${home}/.claude" "${home}/.codex"`,
      `install -m 0644 -o ${uid} -g ${gid} "${skel}" "${home}/.claude/CLAUDE.md"`,
      `install -m 0644 -o ${uid} -g ${gid} "${skel}" "${home}/.codex/AGENTS.md"`,
    ].join("\n");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(join(home, ".claude")).mode & 0o777).toBe(0o755);
    expect(statSync(join(home, ".codex")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe("# rules\n");
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toBe("# rules\n");
  });
});
