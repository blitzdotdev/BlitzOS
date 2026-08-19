import { spawn } from "node:child_process";

// Best-effort refresh of the managed agent rules on an already-running box.
// `blitz-rules sync` fetches the latest rules from the control plane and
// rewrites ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md, or keeps the baked
// fallback on any failure. Claude (via settingSources) and Codex re-read those
// files at the next query/launch, so a running box picks up a rule edit without
// a reboot. This is triggered at session start; it is TTL-gated so a burst of
// sessions runs at most one sync, and fully detached so it can never block or
// fail the session that triggered it.

const REFRESH_TTL_MS = 5 * 60 * 1000;

export interface RulesRefreshClock {
  now(): number;
}

function detachedSync(): void {
  const child = spawn("blitz-rules", ["sync"], { stdio: "ignore", detached: true });
  // A missing binary or spawn error surfaces asynchronously; swallow it so the
  // refresh stays invisible to the session.
  child.on("error", () => undefined);
  child.unref();
}

const systemClock: RulesRefreshClock = { now: () => Date.now() };

export class AgentRulesRefresher {
  private lastAttempt: number | null = null;

  public constructor(
    private readonly run: () => void = detachedSync,
    private readonly clock: RulesRefreshClock = systemClock,
    private readonly ttlMs: number = REFRESH_TTL_MS,
  ) {}

  public maybeRefresh(): void {
    const now = this.clock.now();
    if (this.lastAttempt !== null && now - this.lastAttempt < this.ttlMs) return;
    this.lastAttempt = now;
    try {
      this.run();
    } catch {
      // Never let a synchronous spawn failure disturb the caller.
    }
  }
}
