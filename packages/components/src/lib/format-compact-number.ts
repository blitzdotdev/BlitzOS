/**
 * Locale-aware compact / currency formatting for usage surfaces.
 *
 * Compact units must follow the product language (en → K/M/B, zh → 万/亿), not the
 * host OS locale. Passing `undefined` to `Intl.NumberFormat` falls back to the
 * runtime default and is what previously leaked Chinese units into English UI.
 */

export function formatCompactNumber(
  value: number,
  locale: string | null | undefined
): string {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat(locale ?? 'en', {
    notation: 'compact',
    // Match NumberFlow on the usage KPI/rings: one fraction digit keeps
    // "1.2M" readable without turning large totals into noisy decimals.
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatUsdAmount(
  value: number,
  locale: string | null | undefined,
  options?: { maximumFractionDigits?: number; minimumFractionDigits?: number }
): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(safeValue);
  return new Intl.NumberFormat(locale ?? 'en', {
    style: 'currency',
    currency: 'USD',
    ...(options?.minimumFractionDigits !== undefined
      ? { minimumFractionDigits: options.minimumFractionDigits }
      : {}),
    maximumFractionDigits:
      options?.maximumFractionDigits ?? (abs > 0 && abs < 1 ? 3 : 2),
  }).format(safeValue);
}
