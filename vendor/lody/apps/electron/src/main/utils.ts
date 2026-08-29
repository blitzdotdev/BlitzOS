export function clampInteger(
  value: number | undefined,
  minValue: number,
  maxValue: number,
  defaultValue: number
): number {
  if (!Number.isFinite(value)) return defaultValue
  const rounded = Math.floor(value as number)
  if (rounded < minValue) return minValue
  if (rounded > maxValue) return maxValue
  return rounded
}

export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function normalizeExternalHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}
