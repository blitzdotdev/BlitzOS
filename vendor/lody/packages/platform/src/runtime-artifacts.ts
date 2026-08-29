/** Public immutable artifact distribution shared by local and cloud builds. */
export const DEFAULT_RUNTIME_ARTIFACTS_BASE_URL = 'https://api.lody.ai';

export function normalizeRuntimeArtifactsBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, '');
  if (!normalized) {
    throw new Error('Runtime artifacts base URL must not be empty');
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error(`Invalid runtime artifacts base URL: ${value}`);
  }
  return normalized;
}

export function resolveRuntimeArtifactsBaseUrl(overrideBaseUrl?: string): string {
  if (overrideBaseUrl?.trim()) {
    return normalizeRuntimeArtifactsBaseUrl(overrideBaseUrl);
  }
  return DEFAULT_RUNTIME_ARTIFACTS_BASE_URL;
}
