import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_BINARY, claudeEnv } from "../src/adapters/claude.js";
import { CredentialSource } from "../src/credentials.js";

/**
 * Chat delivery is an environment variable, and these pin the three facts that
 * make it work.
 *
 * Verified offline against a 127.0.0.1 mock upstream, at the versions this
 * image ships (`@anthropic-ai/claude-code@2.1.228`,
 * `@anthropic-ai/claude-agent-sdk@0.3.228`): with both
 * `CLAUDE_CODE_OAUTH_TOKEN` in the environment and a populated
 * `$HOME/.claude/.credentials.json`, the engine sends the ENV token and the
 * on-disk one never reaches the wire. `options.env` was also confirmed to
 * REPLACE `process.env` rather than merge with it.
 */
describe("claude chat delivery", () => {
  it("spreads the process environment, because options.env replaces it", () => {
    const base = { PATH: "/usr/bin", LANG: "C.UTF-8", HOME: "/var/lib/blitz/home" };
    const env = claudeEnv("sk-ant-oat01-token", base);
    // Drop the spread and the engine loses the VM's whole environment.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("C.UTF-8");
  });

  it("delivers the broker token on the OAuth variable, never as an API key", () => {
    const env = claudeEnv("sk-ant-oat01-token", { HOME: "/var/lib/blitz/home" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-token");
    // ANTHROPIC_API_KEY is the API-key hook: it rejects an OAuth token outright
    // and switches a subscription to per-token billing on the way.
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
  });

  it("sets HOME explicitly and pins the auto-updater off", () => {
    const env = claudeEnv(null, { HOME: "/inherited" }, "/var/lib/blitz/home");
    expect(env.HOME).toBe("/var/lib/blitz/home");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
  });

  it("runs signed out rather than failing when there is no token", () => {
    const env = claudeEnv(null, { HOME: "/var/lib/blitz/home" });
    expect("CLAUDE_CODE_OAUTH_TOKEN" in env).toBe(false);
    expect(env.HOME).toBe("/var/lib/blitz/home");
  });

  it("refuses to export a token that carries whitespace", () => {
    // The newline the broker's Fprintln adds is stripped one layer down, but
    // this is the layer that hands the bytes to the vendor, and a corrupted
    // OAuth token comes back as a 401 that reads exactly like a lapsed
    // subscription. Failing by name here beats debugging someone's billing.
    const home = { HOME: "/var/lib/blitz/home" };
    for (const corrupted of ["sk-ant-oat01-token\n", "sk-ant-oat01-token\r\n", " sk-ant-oat01-token", "sk-ant oat01"]) {
      expect(() => claudeEnv(corrupted, home)).toThrow("refusing to export a whitespace-bearing OAuth token");
    }
    expect(claudeEnv("sk-ant-oat01-token", home).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-token");
  });

  it("runs the real pinned binary, not the PATH shim", () => {
    // The shim mints a token for ITSELF, so a turn routed through it reports on
    // the shim's token instead of the one this process was handed.
    expect(CLAUDE_BINARY).toBe("/opt/blitz/npm/bin/claude");
    expect(CLAUDE_BINARY).not.toBe("/usr/local/bin/claude");
    expect(CLAUDE_BINARY.startsWith("/")).toBe(true);
  });
});

const directories: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A state directory wired to a broker, with a `blitz-cred` on PATH that prints
 * `stdout` the way the real one does.
 */
function brokerBox(stdout: string): CredentialSource {
  const directory = mkdtempSync(join(tmpdir(), "blitz-cred-"));
  directories.push(directory);
  // The presence of this file is the whole "is a broker configured" test.
  writeFileSync(join(directory, "broker.json"), "{}");
  // Byte-for-byte through a file, so the shell cannot reinterpret an escape on
  // the way and the child writes exactly what the broker would have written.
  const payload = join(directory, "stdout");
  writeFileSync(payload, stdout);
  const shim = join(directory, "blitz-cred");
  writeFileSync(shim, `#!/bin/sh\nexec cat '${payload}'\n`);
  chmodSync(shim, 0o755);
  process.env.PATH = `${directory}:${originalPath ?? ""}`;
  return new CredentialSource(directory);
}

/**
 * The delivered token is the ONE thing the whole chat credential path exists to
 * get right, and a single trailing byte is enough to break it.
 *
 * The broker writes the minted token with `fmt.Fprintln`, so what leaves it is
 * `<token>\n`. `workspace.Token` returns the ssh stdout verbatim, `blitz-cred
 * token` writes it through, and this process reads it here. The terminal shim
 * never noticed because `$(…)` strips trailing newlines; the chat path puts the
 * bytes straight into an environment variable, where the newline rides along to
 * the vendor and every request comes back unauthenticated.
 */
describe("broker token delivery", () => {
  it("trims the newline the broker's Fprintln adds", async () => {
    const token = await brokerBox("sk-ant-oat01-token\n").token("claude");
    expect(token).toBe("sk-ant-oat01-token");
    const env = claudeEnv(token, { HOME: "/var/lib/blitz/home" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-token");
    // The assertion that actually matters: whatever reaches the engine carries
    // no line break, whichever hop introduced one.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).not.toMatch(/[\r\n]/u);
  });

  it("refuses stdout that is not one opaque line", async () => {
    // Repairing this would deliver whichever fragment survived the repair, so
    // it is a refusal: a token is one line, and two lines is a broker fault.
    await expect(brokerBox("sk-ant-oat01-a\nsk-ant-oat01-b\n").token("claude"))
      .rejects.toThrow("broker returned an invalid token");
    await expect(brokerBox("\n\n").token("claude"))
      .rejects.toThrow("broker returned an invalid token");
  });

  it("runs signed out when no broker is configured for the workspace", async () => {
    const directory = mkdtempSync(join(tmpdir(), "blitz-cred-"));
    directories.push(directory);
    expect(await new CredentialSource(directory).token("claude")).toBeNull();
  });
});
