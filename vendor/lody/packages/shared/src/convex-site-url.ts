export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function deriveConvexSiteUrl(convexUrl: string): string {
  try {
    const url = new URL(convexUrl);
    if (url.hostname.endsWith('.convex.cloud')) {
      url.hostname = url.hostname.replace(/\.convex\.cloud$/, '.convex.site');
    }
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return normalizeBaseUrl(url.toString());
  } catch {
    return normalizeBaseUrl(convexUrl);
  }
}
