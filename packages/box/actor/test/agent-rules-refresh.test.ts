import { describe, expect, it } from "vitest";
import { createRulesRefresher } from "../src/agent-rules-refresh.js";

function fixedClock(start: number): { now: () => number; set(value: number): void } {
  let current = start;
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
  };
}

describe("createRulesRefresher", () => {
  it("runs once and then suppresses repeats inside the TTL window", () => {
    let runs = 0;
    const clock = fixedClock(1_000);
    const refresh = createRulesRefresher(() => {
      runs += 1;
    }, clock.now, 5 * 60 * 1000);

    refresh();
    refresh();
    clock.set(1_000 + 4 * 60 * 1000);
    refresh();

    expect(runs).toBe(1);
  });

  it("runs again once the TTL has elapsed", () => {
    let runs = 0;
    const clock = fixedClock(0);
    const refresh = createRulesRefresher(() => {
      runs += 1;
    }, clock.now, 5 * 60 * 1000);

    refresh();
    clock.set(5 * 60 * 1000);
    refresh();
    clock.set(10 * 60 * 1000);
    refresh();

    expect(runs).toBe(3);
  });

  it("swallows a synchronous spawn failure and stays gated", () => {
    let attempts = 0;
    const clock = fixedClock(0);
    const refresh = createRulesRefresher(() => {
      attempts += 1;
      throw new Error("spawn failed");
    }, clock.now, 1000);

    expect(() => refresh()).not.toThrow();
    // The attempt still counts against the TTL, so a failing box does not spin.
    refresh();
    expect(attempts).toBe(1);
  });

  it("keeps each refresher's TTL to itself", () => {
    let first = 0;
    let second = 0;
    const clock = fixedClock(0);
    const refreshFirst = createRulesRefresher(() => {
      first += 1;
    }, clock.now, 1000);
    const refreshSecond = createRulesRefresher(() => {
      second += 1;
    }, clock.now, 1000);

    refreshFirst();
    refreshSecond();

    expect(first).toBe(1);
    expect(second).toBe(1);
  });
});
