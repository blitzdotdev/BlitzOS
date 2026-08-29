import { spawn } from 'node:child_process'

// GUI-launched apps (macOS launchd, Linux .desktop) inherit a minimal PATH that
// usually omits /usr/local/bin, Homebrew, and editor CLIs (`code`, `cursor`,
// ...). We probe the user's login shell once to recover their real environment
// (most importantly PATH) and reuse it whenever we spawn user-facing commands —
// the embedded CLI as well as "Open in" path launchers — so bare command names
// resolve the same way they do in a terminal.

const SHELL_ENV_TIMEOUT_MS = 3000

let cachedShellEnvPromise: Promise<NodeJS.ProcessEnv | null> | null = null

function parseNullDelimitedEnv(payload: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {}
  const entries = payload.split('\0')
  for (const entry of entries) {
    if (!entry) continue
    const separatorIndex = entry.indexOf('=')
    if (separatorIndex <= 0) continue
    const key = entry.slice(0, separatorIndex)
    const value = entry.slice(separatorIndex + 1)
    parsed[key] = value
  }
  return parsed
}

function resolveShellEnvCommand(shellPath: string): { command: string; args: string[] } {
  if (shellPath.endsWith('/bash')) {
    return {
      command: shellPath,
      args: ['-ilc', 'source ~/.bashrc >/dev/null 2>&1 || true; env -0']
    }
  }
  if (shellPath.endsWith('/zsh')) {
    return {
      command: shellPath,
      args: ['-ilc', 'env -0']
    }
  }
  return {
    command: shellPath,
    args: ['-lc', 'env -0']
  }
}

async function loadUserShellEnv(): Promise<NodeJS.ProcessEnv | null> {
  if (process.platform === 'win32') return null
  if (process.env.LODY_ELECTRON_DISABLE_SHELL_ENV === '1') return null
  const shellPath = process.env.SHELL
  if (!shellPath) return null

  const shellCommand = resolveShellEnvCommand(shellPath)
  return await new Promise<NodeJS.ProcessEnv | null>((resolve) => {
    const child = spawn(shellCommand.command, shellCommand.args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
    }, SHELL_ENV_TIMEOUT_MS)

    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)))

    child.on('error', (error) => {
      clearTimeout(timeout)
      console.warn('Failed to load shell environment', error)
      resolve(null)
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
        if (stderr) {
          console.warn(`Shell environment probe exited with code ${code}: ${stderr}`)
        } else {
          console.warn(`Shell environment probe exited with code ${code}`)
        }
        resolve(null)
        return
      }
      const payload = Buffer.concat(stdoutChunks).toString('utf8')
      const parsed = parseNullDelimitedEnv(payload)
      resolve(Object.keys(parsed).length > 0 ? parsed : null)
    })
  })
}

/**
 * Resolve (and cache for the process lifetime) the user's login-shell
 * environment. Returns null on Windows, when disabled, or when the probe fails;
 * callers should fall back to `process.env` in that case.
 */
export async function getUserShellEnvCached(): Promise<NodeJS.ProcessEnv | null> {
  if (!cachedShellEnvPromise) {
    cachedShellEnvPromise = loadUserShellEnv()
  }
  return await cachedShellEnvPromise
}

/**
 * Windows `.cmd`/`.bat` shims (and bare command names that resolve to them)
 * cannot be spawned with `shell:false`. Returns true when the spawn must go
 * through the shell so the shim is found and executed.
 */
export function shouldUseWindowsShell(command: string): boolean {
  if (process.platform !== 'win32') return false
  const normalized = command.trim().toLowerCase()
  if (normalized.endsWith('.cmd') || normalized.endsWith('.bat')) {
    return true
  }
  return (
    !normalized.includes('\\') &&
    !normalized.includes('/') &&
    !normalized.endsWith('.exe') &&
    !normalized.endsWith('.com')
  )
}
