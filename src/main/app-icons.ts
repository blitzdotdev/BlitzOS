// macOS app-icon resolver for the connectors list. Each window the helper reports carries a `pid`; here we
// derive the OWNING app's icon (base64 PNG) from that pid, WITHOUT touching the BlitzComputerUse helper — the
// helper holds the Screen-Recording grant on its installed bundle, so rebuilding it to add icons would break
// the grant. Electron's app.getFileIcon does it natively: pid → executable path (`ps -o comm=` gives the full
// path on macOS) → first ".app" ancestor → its icon. Best-effort: a window with no resolvable icon just keeps
// none (the renderer falls back to a letter). Cached by pid + by path (an app's icon is stable while it runs).
import { app } from 'electron'
import { execFile } from 'node:child_process'

const pidIcon = new Map<number, string>() // pid -> base64 PNG (a live pid's app never changes)
const pathIcon = new Map<string, string | undefined>() // .app path -> base64 PNG (undefined = resolved-but-empty)

function pathsForPids(pids: number[]): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    const out = new Map<number, string>()
    if (!pids.length) return resolve(out)
    execFile('ps', ['-p', pids.join(','), '-o', 'pid=,comm='], { maxBuffer: 1 << 20 }, (err, stdout) => {
      if (!err && stdout) {
        for (const line of stdout.split('\n')) {
          // "  1234 /Applications/Ghostty.app/Contents/MacOS/ghostty" → pid + first ".app" ancestor.
          const m = line.match(/^\s*(\d+)\s+(\/.*?\.app)(?:\/|$)/)
          if (m) out.set(Number(m[1]), m[2])
        }
      }
      resolve(out)
    })
  })
}

// app.getFileIcon hands back the SAME generic placeholder for every path in a non-bundled (dev) Electron process
// — only a packaged .app gets the true per-app icons. So learn the generic once (the icon of a path that does not
// exist) and treat any match as "no icon", letting the UI fall back to a clean letter tile instead of a broken
// generic. In a packaged build the real per-app icons differ from the generic and are used as-is.
let genericRef: string | null | undefined
async function genericIcon(): Promise<string | null> {
  if (genericRef !== undefined) return genericRef
  try {
    const img = await app.getFileIcon('/System/.blitz-no-such-app.app', { size: 'normal' })
    genericRef = img.isEmpty() ? null : img.toPNG().toString('base64')
  } catch {
    genericRef = null
  }
  return genericRef
}

async function iconForPath(appPath: string): Promise<string | undefined> {
  if (pathIcon.has(appPath)) return pathIcon.get(appPath)
  let b64: string | undefined
  try {
    const img = await app.getFileIcon(appPath, { size: 'normal' })
    const png = img.isEmpty() ? '' : img.toPNG().toString('base64')
    b64 = png && png !== (await genericIcon()) ? png : undefined
  } catch {
    b64 = undefined
  }
  pathIcon.set(appPath, b64)
  return b64
}

/** Enrich window descriptors {pid,...} with `icon` (base64 PNG). Best-effort; missing icons stay undefined. */
export async function attachAppIcons<T extends { pid?: number | string }>(windows: T[]): Promise<Array<T & { icon?: string }>> {
  const need = [...new Set(windows.map((w) => Number(w.pid)).filter((p) => p > 0 && !pidIcon.has(p)))]
  if (need.length) {
    const paths = await pathsForPids(need)
    await Promise.all(
      [...paths.entries()].map(async ([pid, appPath]) => {
        const b64 = await iconForPath(appPath)
        if (b64) pidIcon.set(pid, b64)
      })
    )
  }
  return windows.map((w) => {
    const icon = pidIcon.get(Number(w.pid))
    return icon ? { ...w, icon } : w
  })
}
