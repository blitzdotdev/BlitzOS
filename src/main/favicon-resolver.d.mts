// Types for the main-process favicon resolver (favicon-resolver.mjs).

/**
 * Resolve a favicon URL to a base64 `data:` URL via a neutral main-process fetch, with caching + de-duping.
 * Never rejects: resolves to the data URL, or null when the icon can't be obtained (→ keep the globe glyph).
 * @param rawUrl the same `<origin>/favicon.ico` the renderer <img> tried
 */
export function resolveFavicon(rawUrl: string): Promise<string | null>

export const __test: {
  normalize(rawUrl: string): string | null
  imageMime(contentType: string | null, buf: Buffer): string | null
  isPrivateIp(ip: string): boolean
  assertPublicHost(hostname: string): Promise<void>
  parseIconHref(html: string, baseUrl: string): string | null
  CACHE: Map<string, { value: string | null; expires: number }>
  PENDING: Map<string, Promise<string | null>>
}
