export function normalizeAppBasePath(appBasePath: string): string {
  const trimmed = appBasePath.trim();
  if (!trimmed || trimmed === '/') return '';
  const normalizedSegment = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalizedSegment) return '';
  return `/${normalizedSegment}`;
}
