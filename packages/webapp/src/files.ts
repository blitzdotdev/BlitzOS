import { hasObjectType, isNumber } from './type-guards';

export function davErrorStatus(cause: unknown): number | undefined {
  if (!cause || !hasObjectType(cause)) return undefined;
  // SAFETY: The preceding check permits reading an optional property from a non-null object; it does not claim any broader DAV error shape.
  const status = (cause as { status?: unknown }).status;
  return isNumber(status) ? status : undefined;
}

export function fullDavPath(filePath: string): string {
  return `~/${filePath}`;
}

/** True when candidate is the path itself or one of its descendants. */
export function isPathAtOrBelow(path: string, candidate: string): boolean {
  return candidate === path || candidate.startsWith(`${path}/`);
}

export function shellQuotedPath(filePath: string): string {
  return `~/'${filePath.replaceAll("'", "'\\''")}'`;
}
