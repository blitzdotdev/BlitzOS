const DEFAULT_MIN_RETRY_MS = 1000;
const DEFAULT_MAX_RETRY_MS = 60_000;
const DEFAULT_JITTER_FRACTION = 0.2;

export type RetryDelayOptions = {
  jitterFraction?: number;
  random?: () => number;
};

export function buildRetryDelay(
  attempt: number,
  minMs: number = DEFAULT_MIN_RETRY_MS,
  maxMs: number = DEFAULT_MAX_RETRY_MS,
  options: RetryDelayOptions = {}
): number {
  const exponent = Math.max(0, attempt);
  const baseDelay = Math.min(minMs * 2 ** exponent, maxMs);
  const jitterFraction = Math.max(0, options.jitterFraction ?? DEFAULT_JITTER_FRACTION);
  if (jitterFraction === 0) {
    return baseDelay;
  }

  const random = options.random ?? Math.random;
  const randomValue = Math.min(1, Math.max(0, random()));
  const jitterMultiplier = 1 + (randomValue * 2 - 1) * jitterFraction;
  return Math.min(Math.max(0, Math.round(baseDelay * jitterMultiplier)), maxMs);
}

export class FailureWindow {
  private readonly historyMs: number[] = [];
  private readonly windowMs: number;
  private readonly threshold: number;

  constructor(windowMs: number, threshold: number) {
    this.windowMs = windowMs;
    this.threshold = threshold;
  }

  record(): boolean {
    const nowMs = Date.now();
    this.historyMs.push(nowMs);
    const cutoff = nowMs - this.windowMs;
    while (this.historyMs.length > 0) {
      const earliest = this.historyMs[0];
      if (earliest === undefined || earliest >= cutoff) {
        break;
      }
      this.historyMs.shift();
    }
    return this.historyMs.length >= this.threshold;
  }

  reset(): void {
    this.historyMs.length = 0;
  }

  get recentCount(): number {
    return this.historyMs.length;
  }

  get windowMinutes(): number {
    return Math.round(this.windowMs / 60_000);
  }
}

export function isAlreadyRunningOutcome(result: {
  code: number | null;
  stdout: string;
  stderr: string;
}): boolean {
  if (result.code === 3) return true;
  if (result.code !== 1) return false;
  const combined = `${result.stdout}\n${result.stderr}`;
  return /service is already running|already running|port is in use/i.test(combined);
}
