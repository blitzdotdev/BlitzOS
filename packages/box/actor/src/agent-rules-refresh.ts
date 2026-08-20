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

function detachedSync(): void {
  const child = spawn("blitz-rules", ["sync"], { stdio: "ignore", detached: true });
  // A missing binary or spawn error surfaces asynchronously; swallow it so the
  // refresh stays invisible to the session.
  child.on("error", () => undefined);
  child.unref();
}

/** Returns the "a session started" callback the actor service calls. The two
 * optional arguments are test seams; production passes neither. The returned
 * function never throws, so callers need no guard of their own. */
export function createRulesRefresher(
  run: () => void = detachedSync,
  now: () => number = Date.now,
  ttlMs: number = REFRESH_TTL_MS,
): () => void {
  let lastAttempt: number | null = null;
  return () => {
    const attemptedAt = now();
    if (lastAttempt !== null && attemptedAt - lastAttempt < ttlMs) return;
    // The attempt counts against the TTL whether or not it works, so a box
    // whose spawn keeps failing does not spin on every session.
    lastAttempt = attemptedAt;
    try {
      run();
    } catch {
      // Never let a synchronous spawn failure disturb the caller.
    }
  };
}
