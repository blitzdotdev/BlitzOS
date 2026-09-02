export function shellQuotedPath(filePath: string): string {
  return `~/'${filePath.replaceAll("'", "'\\''")}'`;
}
