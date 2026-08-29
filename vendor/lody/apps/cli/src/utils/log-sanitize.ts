const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'authorization',
  'auth',
  'password',
  'key',
  'api_key',
]);

export function sanitizeUrlForLogging(raw: string): string {
  try {
    const url = new URL(raw);

    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }

    for (const key of SENSITIVE_QUERY_KEYS) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, 'REDACTED');
      }
    }

    return url.toString();
  } catch {
    return raw;
  }
}

export function redactProxyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const hasAuth = url.username.length > 0 || url.password.length > 0;
    const auth = hasAuth ? '[redacted]@' : '';
    const pathname = url.pathname === '/' ? '' : url.pathname;
    const search = url.search;
    return `${url.protocol}//${auth}${url.host}${pathname}${search}`;
  } catch {
    return raw.replace(/\/\/([^@]+)@/g, '//[redacted]@');
  }
}
