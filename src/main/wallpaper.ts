import { ipcMain, nativeImage, type NativeImage } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const exec = promisify(execFile)
// Captures the real desktop wallpaper (incl. dynamic/aerial) by snapshotting the
// Wallpaper-owned window; see the TODOs in loadWallpaper for production caveats.

// Swift helper that prints the CGWindowID of the desktop wallpaper window — owned by
// "Wallpaper" on modern macOS, else the lowest-layer full-screen window. Capturing that
// window gives the real wallpaper pixels (works for static AND dynamic/aerial wallpapers,
// which expose no static image path) with none of the app windows in front of it.
const WIN_FINDER = `
import CoreGraphics
import Foundation
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
var best: (num: Int, layer: Int)? = nil
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let wd = (b["Width"] as? Double) ?? 0, ht = (b["Height"] as? Double) ?? 0
  let num = w[kCGWindowNumber as String] as? Int ?? -1
  guard wd > 800, ht > 500 else { continue }
  if owner == "Wallpaper" { print(num); exit(0) }
  if layer < 0, best == nil || layer < best!.layer { best = (num, layer) }
}
if let b = best { print(b.num) }
`

// Memoize the PROMISE (not the result) so concurrent first calls — e.g. React
// StrictMode mounting the wallpaper hook twice — share ONE capture instead of racing
// (the loser used to clobber a good result with null, and both hit the same temp file).
let cached: Promise<string | null> | undefined

export function registerWallpaperIpc(): void {
  ipcMain.handle('os:wallpaper', (): Promise<string | null> => {
    if (!cached) cached = loadWallpaper()
    return cached
  })
}

async function loadWallpaper(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  const script = join(tmpdir(), `blitz-wallfind-${process.pid}.swift`)
  const shot = join(tmpdir(), `blitz-wall-${process.pid}.png`)
  try {
    await writeFile(script, WIN_FINDER, 'utf8')
    // TODO(prod): ship a precompiled helper — `xcrun swift` needs the Xcode toolchain,
    // which a Finder-launched packaged app won't have on PATH (degrades to the gradient).
    const { stdout } = await exec('xcrun', ['swift', script], { timeout: 9000 })
    const id = stdout.trim().split('\n')[0]
    if (!/^\d+$/.test(id)) return null
    // TODO(prod): needs Screen Recording permission; if denied, screencapture yields a
    // black frame (no error) — we'd want to detect the all-black case and fall back.
    await exec('screencapture', ['-x', '-o', '-l', id, '-t', 'png', shot], { timeout: 9000 })
    const img = nativeImage.createFromPath(shot)
    if (img.isEmpty() || isMostlyBlack(img)) return null
    // Heavy blur is applied in CSS, so a small image is plenty (and cheap over IPC).
    return img.resize({ width: 1600 }).toDataURL()
  } catch {
    return null
  } finally {
    void unlink(script).catch(() => {})
    void unlink(shot).catch(() => {})
  }
}

// A Screen-Recording-denied capture returns an all-black frame; treat that as "no
// wallpaper" so onboarding shows the light gradient instead of a black frosted panel.
function isMostlyBlack(img: NativeImage): boolean {
  try {
    const buf = img.resize({ width: 32, height: 20 }).toBitmap() // BGRA
    let maxv = 0
    for (let i = 0; i < buf.length; i += 4) maxv = Math.max(maxv, buf[i], buf[i + 1], buf[i + 2])
    return maxv < 12
  } catch {
    return false
  }
}
