import { describe, expect, it } from 'vitest';
import { buildRetryDelay, FailureWindow, isAlreadyRunningOutcome } from './retry';

describe('buildRetryDelay', () => {
  it('returns minMs for attempt 0', () => {
    expect(buildRetryDelay(0, 1000, 30_000, { random: () => 0.5 })).toBe(1000);
  });

  it('doubles delay with each attempt', () => {
    expect(buildRetryDelay(1, 1000, 30_000, { random: () => 0.5 })).toBe(2000);
    expect(buildRetryDelay(2, 1000, 30_000, { random: () => 0.5 })).toBe(4000);
    expect(buildRetryDelay(3, 1000, 30_000, { random: () => 0.5 })).toBe(8000);
  });

  it('caps at maxMs', () => {
    expect(buildRetryDelay(10, 1000, 30_000, { random: () => 0.5 })).toBe(30_000);
    expect(buildRetryDelay(100, 1000, 30_000, { random: () => 1 })).toBe(30_000);
  });

  it('handles negative attempts as 0', () => {
    expect(buildRetryDelay(-1, 1000, 30_000, { random: () => 0.5 })).toBe(1000);
  });

  it('applies bounded jitter by default', () => {
    expect(buildRetryDelay(2, 1000, 30_000, { random: () => 0 })).toBe(3200);
    expect(buildRetryDelay(2, 1000, 30_000, { random: () => 1 })).toBe(4800);
  });

  it('can disable jitter for deterministic callers', () => {
    expect(buildRetryDelay(2, 1000, 30_000, { jitterFraction: 0, random: () => 1 })).toBe(4000);
  });
});

describe('FailureWindow', () => {
  it('does not trigger fatal below threshold', () => {
    const fw = new FailureWindow(60_000, 3);
    expect(fw.record()).toBe(false);
    expect(fw.record()).toBe(false);
  });

  it('triggers fatal at threshold', () => {
    const fw = new FailureWindow(60_000, 3);
    fw.record();
    fw.record();
    expect(fw.record()).toBe(true);
  });

  it('resets failure history', () => {
    const fw = new FailureWindow(60_000, 3);
    fw.record();
    fw.record();
    fw.reset();
    expect(fw.record()).toBe(false);
  });

  it('exposes recentCount and windowMinutes', () => {
    const fw = new FailureWindow(180_000, 5);
    fw.record();
    fw.record();
    expect(fw.recentCount).toBe(2);
    expect(fw.windowMinutes).toBe(3);
  });
});

describe('isAlreadyRunningOutcome', () => {
  it('returns true for exit code 3', () => {
    expect(isAlreadyRunningOutcome({ code: 3, stdout: '', stderr: '' })).toBe(true);
  });

  it('returns true for port in use message with exit code 1', () => {
    expect(isAlreadyRunningOutcome({ code: 1, stdout: '', stderr: 'port is in use' })).toBe(true);
  });

  it('returns true for already running message with exit code 1', () => {
    expect(
      isAlreadyRunningOutcome({ code: 1, stdout: 'service is already running', stderr: '' })
    ).toBe(true);
  });

  it('returns false for other exit codes', () => {
    expect(isAlreadyRunningOutcome({ code: 0, stdout: '', stderr: '' })).toBe(false);
    expect(isAlreadyRunningOutcome({ code: 2, stdout: '', stderr: '' })).toBe(false);
  });

  it('returns false for exit code 1 without matching message', () => {
    expect(isAlreadyRunningOutcome({ code: 1, stdout: 'some error', stderr: '' })).toBe(false);
  });
});
