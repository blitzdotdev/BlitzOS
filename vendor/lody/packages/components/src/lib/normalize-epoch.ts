/**
 * Normalize a timestamp to epoch milliseconds. Accepts values that may be in
 * seconds (backend often returns seconds-granularity) — anything under ~year
 * 2286 in seconds is treated as seconds and converted to ms.
 */
export const normalizeEpochMs = (value: number | null | undefined): number | null => {
  if (value == null) return null;
  if (!Number.isFinite(value)) return null;
  if (value > 0 && value < 10_000_000_000) return value * 1000;
  return value;
};
