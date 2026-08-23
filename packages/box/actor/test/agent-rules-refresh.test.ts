import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createRulesRefresher } from "../src/agent-rules-refresh.js";

// The refresher's whole job is the boundary call: a detached, unref'd
// `blitz-rules sync` at most once per TTL window. Stub the boundary itself
// (child_process) and drive the TTL with fake time.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

const spawnMock = vi.mocked(spawn);
const TTL_MS = 5 * 60 * 1000;

describe("createRulesRefresher", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000 });
    spawnMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns one detached blitz-rules sync and suppresses repeats inside the TTL window", () => {
    const refresh = createRulesRefresher();

    refresh();
    refresh();
    vi.setSystemTime(1_000 + TTL_MS - 60_000);
    refresh();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("blitz-rules", ["sync"], {
      stdio: "ignore",
      detached: true,
    });
    // Detached AND unref'd, or the refresh would pin the actor's event loop.
    const child = spawnMock.mock.results[0]?.value as { on: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("runs again once the TTL has elapsed", () => {
    const refresh = createRulesRefresher();

    refresh();
    vi.setSystemTime(1_000 + TTL_MS);
    refresh();
    vi.setSystemTime(1_000 + 2 * TTL_MS);
    refresh();

    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it("keeps each refresher's TTL to itself", () => {
    const refreshFirst = createRulesRefresher();
    const refreshSecond = createRulesRefresher();

    refreshFirst();
    refreshSecond();

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
