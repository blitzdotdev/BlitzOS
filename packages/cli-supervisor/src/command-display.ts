function quotePosixArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&')}"`;
}

export function formatCommandForDisplay(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform
): string {
  // Quote every displayed argv token, not only shell-unsafe values: packaged macOS
  // launches use the app executable plus a bundled CLI entry under Resources, and
  // unquoted display makes those separate argv items look like one malformed path.
  const quote = platform === 'win32' ? quoteWindowsArg : quotePosixArg;
  return [command, ...args].map(quote).join(' ');
}
