import { describe, expect, it } from "vitest";
import { CLAUDE_BINARY, claudeEnv } from "../src/adapters/claude.js";

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

  it("runs the real pinned binary, not the PATH shim", () => {
    // The shim mints a token for ITSELF, so a turn routed through it reports on
    // the shim's token instead of the one this process was handed.
    expect(CLAUDE_BINARY).toBe("/opt/blitz/npm/bin/claude");
    expect(CLAUDE_BINARY).not.toBe("/usr/local/bin/claude");
    expect(CLAUDE_BINARY.startsWith("/")).toBe(true);
  });
});
