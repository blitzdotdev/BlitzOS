import { describe, expect, it } from "vitest";
import { AgentRulesRefresher, type RulesRefreshClock } from "../src/agent-rules-refresh.js";

function fixedClock(start: number): RulesRefreshClock & { set(value: number): void } {
  let current = start;
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
  };
}

describe("AgentRulesRefresher", () => {
  it("runs once and then suppresses repeats inside the TTL window", () => {
    let runs = 0;
    const clock = fixedClock(1_000);
    const refresher = new AgentRulesRefresher(() => {
      runs += 1;
    }, clock, 5 * 60 * 1000);

    refresher.maybeRefresh();
    refresher.maybeRefresh();
    clock.set(1_000 + 4 * 60 * 1000);
    refresher.maybeRefresh();

    expect(runs).toBe(1);
  });

  it("runs again once the TTL has elapsed", () => {
    let runs = 0;
    const clock = fixedClock(0);
    const refresher = new AgentRulesRefresher(() => {
      runs += 1;
    }, clock, 5 * 60 * 1000);

    refresher.maybeRefresh();
    clock.set(5 * 60 * 1000);
    refresher.maybeRefresh();
    clock.set(10 * 60 * 1000);
    refresher.maybeRefresh();

    expect(runs).toBe(3);
  });

  it("swallows a synchronous spawn failure and stays gated", () => {
    let attempts = 0;
    const clock = fixedClock(0);
    const refresher = new AgentRulesRefresher(() => {
      attempts += 1;
      throw new Error("spawn failed");
    }, clock, 1000);

    expect(() => refresher.maybeRefresh()).not.toThrow();
    // The attempt still counts against the TTL, so a failing box does not spin.
    refresher.maybeRefresh();
    expect(attempts).toBe(1);
  });
});
