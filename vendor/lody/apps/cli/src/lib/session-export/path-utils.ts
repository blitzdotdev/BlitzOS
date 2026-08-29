import path from 'node:path';

export function encodeExportPathSegment(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const encoded = encodeURIComponent(trimmed);
  return encoded || fallback;
}

export function ensurePathWithinBase(baseDir: string, candidatePath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedCandidate;
  }

  throw new Error(`Resolved export path escapes base directory: ${candidatePath}`);
}

export function joinExportPath(baseDir: string, ...segments: string[]): string {
  return ensurePathWithinBase(baseDir, path.join(baseDir, ...segments));
}
