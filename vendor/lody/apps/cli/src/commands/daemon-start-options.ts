export interface DaemonStartOptions {
  auth?: string;
  machineName?: string;
  /** Opt out of the pre-spawn backend connectivity + sign-in check. */
  skipAuthCheck?: boolean;
}

export function buildDaemonStartPassthroughArgs(
  options: DaemonStartOptions,
  unknownArgs: readonly string[]
): string[] {
  const sanitized: string[] = [];
  for (let index = 0; index < unknownArgs.length; index += 1) {
    const arg = unknownArgs[index];
    if (arg === '--auth') {
      index += 1;
      continue;
    }
    if (arg?.startsWith('--auth=')) continue;
    if (arg) sanitized.push(arg);
  }
  return [...(options.machineName ? ['--machine-name', options.machineName] : []), ...sanitized];
}
