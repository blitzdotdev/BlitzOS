export function davErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

export function fullDavPath(filePath: string): string {
  return `~/${filePath}`;
}

export function shellQuotedPath(filePath: string): string {
  return `~/'${filePath.replaceAll("'", "'\\''")}'`;
}
