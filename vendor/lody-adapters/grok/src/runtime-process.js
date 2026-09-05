import { spawn } from 'node:child_process';

export function spawnGrokRuntime(
  grokPath,
  { env = process.env, spawnImpl = spawn } = {}
) {
  return spawnImpl(grokPath, ['agent', 'stdio'], {
    env: { ...env, GROK_DISABLE_AUTOUPDATER: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
}
