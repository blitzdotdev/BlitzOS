import type { RateLimit, RateLimitWindow } from 'acp-extension-core';

type LegacyRateLimitWindow = {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
};

type LegacyRateLimit = {
  planName?: unknown;
  limitName?: unknown;
  limitId?: unknown;
  windows?: unknown;
  fiveHour?: unknown;
  sevenDay?: unknown;
  fiveHourResetAt?: unknown;
  sevenDayResetAt?: unknown;
  extraUsage?: unknown;
};

const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function epochSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value >= 1_000_000_000_000 ? value / 1_000 : value);
}

function usedPercent(value: unknown, provider: string): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = provider === 'claude' && value >= 0 && value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, normalized));
}

function legacyWindow(
  value: unknown,
  durationSeconds: number,
  reset: unknown,
  provider: string
): RateLimitWindow | null {
  const normalized = usedPercent(value, provider);
  if (normalized === null) return null;
  return {
    usedPercent: normalized,
    windowDurationSeconds: durationSeconds,
    resetsAtEpochSeconds: epochSeconds(reset),
  };
}

function legacyWallet(value: unknown): RateLimit['wallet'] {
  if (!isRecord(value)) return undefined;
  const fields = [
    'balanceCents',
    'totalCents',
    'monthlyChargeLimitCents',
    'monthlyUsedCents',
  ] as const;
  if (fields.some((field) => typeof value[field] !== 'number')) return undefined;
  if (typeof value.monthlyChargeLimitEnabled !== 'boolean' || typeof value.currency !== 'string') {
    return undefined;
  }
  return {
    balanceCents: value.balanceCents as number,
    totalCents: value.totalCents as number,
    monthlyChargeLimitEnabled: value.monthlyChargeLimitEnabled,
    monthlyChargeLimitCents: value.monthlyChargeLimitCents as number,
    monthlyUsedCents: value.monthlyUsedCents as number,
    currency: value.currency,
  };
}

/** One-release migration for rate-limit rows written before Core v0.1. */
export function normalizePersistedRateLimit(
  provider: string,
  keyLimitId: string | null,
  value: unknown
): RateLimit | null {
  if (!isRecord(value)) return null;
  const currentWindows = value.windows;
  if (
    typeof value.limitId === 'string' &&
    isRecord(value.scope) &&
    typeof value.scope.providerId === 'string' &&
    Array.isArray(currentWindows) &&
    currentWindows.every(
      (window) =>
        isRecord(window) &&
        typeof window.usedPercent === 'number' &&
        (typeof window.windowDurationSeconds === 'number' ||
          window.windowDurationSeconds === null) &&
        (typeof window.resetsAtEpochSeconds === 'number' || window.resetsAtEpochSeconds === null)
    )
  ) {
    return value as RateLimit;
  }

  const legacy = value as LegacyRateLimit;
  const windows: RateLimitWindow[] = [];
  if (Array.isArray(legacy.windows)) {
    for (const rawWindow of legacy.windows as LegacyRateLimitWindow[]) {
      const percent = usedPercent(rawWindow?.usedPercent, provider);
      if (percent === null) continue;
      const minutes = rawWindow?.windowDurationMins;
      windows.push({
        usedPercent: percent,
        windowDurationSeconds:
          typeof minutes === 'number' && Number.isFinite(minutes) ? minutes * 60 : null,
        resetsAtEpochSeconds: epochSeconds(rawWindow?.resetsAt),
      });
    }
  } else {
    const primaryDuration =
      provider === 'codex' && legacy.fiveHour != null && legacy.sevenDay == null
        ? SEVEN_DAYS_SECONDS
        : FIVE_HOURS_SECONDS;
    const primary = legacyWindow(
      legacy.fiveHour,
      primaryDuration,
      legacy.fiveHourResetAt,
      provider
    );
    const weekly = legacyWindow(
      legacy.sevenDay,
      SEVEN_DAYS_SECONDS,
      legacy.sevenDayResetAt,
      provider
    );
    if (primary) windows.push(primary);
    if (weekly) windows.push(weekly);
  }

  const limitId = optionalString(legacy.limitId) ?? keyLimitId ?? provider;
  if (!limitId) return null;
  return {
    limitId,
    scope: { providerId: provider },
    ...(optionalString(legacy.limitName) !== undefined
      ? { limitName: optionalString(legacy.limitName) }
      : {}),
    ...(optionalString(legacy.planName) !== undefined
      ? { planName: optionalString(legacy.planName) }
      : {}),
    windows,
    ...(legacyWallet(legacy.extraUsage) !== undefined
      ? { wallet: legacyWallet(legacy.extraUsage) }
      : {}),
  };
}
