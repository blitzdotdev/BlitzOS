import { ipcMain, webContents, type WebContents } from 'electron'

/**
 * In-window control for `web` surfaces (third-party `<webview>` guests) via the
 * Chrome DevTools Protocol. The renderer reports each web guest's webContents id
 * (on dom-ready → ipc `os:register-webview`); here we attach `webContents.debugger`
 * to that guest and dispatch CDP.
 *
 * Why CDP (per the in-window-control eval): it is the only mechanism that gives
 * (a) TRUSTED input — `Input.*` rides Chromium's real input pipeline so
 * `event.isTrusted === true`, which `executeJavaScript` synthetic events can't do;
 * (b) no same-origin requirement (you can't inject into a third-party JS world);
 * (c) it works while the surface is OFF-SCREEN/unfocused (`sendInputEvent` needs a
 * focused window). Only applies to `web`; `app`/`srcdoc` (iframes) and `native`
 * (React) are driven cooperatively elsewhere — see osActions.osControlSurface.
 *
 * The debugger is SINGLE-CLIENT: while attached, the user's DevTools is degraded,
 * and if they open DevTools it detaches us. So we attach lazily on first action
 * and detach on idle / explicit release / surface close — never hold it forever.
 */

export type ControlAction =
  | { action: 'eval'; expression: string } // localhost-only; the relay tool rejects this
  | { action: 'read'; selector?: string }
  | { action: 'click'; selector?: string; x?: number; y?: number }
  | { action: 'type'; text: string; selector?: string; perKey?: boolean }
  | { action: 'key'; key: string }
  | { action: 'screenshot' }

export type ControlResult = { ok: true; result?: unknown } | { ok: false; error: string }

// surfaceId -> guest <webview> webContents id (reported by the renderer)
const registry = new Map<string, number>()
// webContentsId -> idle-detach timer
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>()
const IDLE_DETACH_MS = 60_000

/** Register the IPC the renderer uses to report/withdraw web-surface guests. */
export function initCdp(): void {
  ipcMain.on('os:register-webview', (_e, surfaceId: string, webContentsId: number) => {
    registry.set(surfaceId, webContentsId)
  })
  ipcMain.on('os:unregister-webview', (_e, surfaceId: string) => {
    const wcId = registry.get(surfaceId)
    registry.delete(surfaceId)
    if (wcId !== undefined) detachById(wcId)
  })
}

/** Explicitly hand DevTools back to the user (also fired on surface close). */
export function releaseControl(surfaceId: string): void {
  const wcId = registry.get(surfaceId)
  if (wcId !== undefined) detachById(wcId)
}

function detachById(wcId: number): void {
  const t = idleTimers.get(wcId)
  if (t) {
    clearTimeout(t)
    idleTimers.delete(wcId)
  }
  const wc = webContents.fromId(wcId)
  try {
    if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
  } catch {
    // already detached (e.g. user opened DevTools) — fine
  }
}

function guestFor(surfaceId: string): WebContents {
  const id = registry.get(surfaceId)
  if (id === undefined) throw new Error(`no web surface registered for "${surfaceId}" (only kind:'web' is CDP-controllable)`)
  const wc = webContents.fromId(id)
  if (!wc || wc.isDestroyed()) {
    registry.delete(surfaceId)
    throw new Error(`web surface "${surfaceId}" is no longer alive`)
  }
  return wc
}

function ensureAttached(wc: WebContents): void {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
  // (re)arm the idle-detach timer on every op so we don't hold the debugger
  const prev = idleTimers.get(wc.id)
  if (prev) clearTimeout(prev)
  idleTimers.set(wc.id, setTimeout(() => detachById(wc.id), IDLE_DETACH_MS))
}

async function evaluate(wc: WebContents, expression: string): Promise<unknown> {
  ensureAttached(wc)
  const res = (await wc.debugger.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'evaluation threw')
  return res.result?.value
}

async function dispatchClick(wc: WebContents, x: number, y: number): Promise<void> {
  ensureAttached(wc)
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
}

async function clickSelector(wc: WebContents, selector: string): Promise<void> {
  // CSS-pixel center (same coordinate space CDP Input.* expects); scroll into view first.
  const r = (await evaluate(
    wc,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       el.scrollIntoView({ block: 'center', inline: 'center' });
       const b = el.getBoundingClientRect();
       return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
     })()`
  )) as { x: number; y: number } | null
  if (!r) throw new Error(`selector not found: ${selector}`)
  await dispatchClick(wc, r.x, r.y)
}

// Named keys → CDP key event fields. Covers the keys that fire real keydown/keyup
// (which Input.insertText does NOT) — Enter/Tab/arrows etc. that editors react to.
const KEYMAP: Record<string, { code: string; key: string; vk: number }> = {
  Enter: { code: 'Enter', key: 'Enter', vk: 13 },
  Tab: { code: 'Tab', key: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', key: 'Delete', vk: 46 },
  Escape: { code: 'Escape', key: 'Escape', vk: 27 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 }
}

async function pressKey(wc: WebContents, name: string): Promise<void> {
  const k = KEYMAP[name]
  if (!k) throw new Error(`unsupported key "${name}" (supported: ${Object.keys(KEYMAP).join(', ')})`)
  ensureAttached(wc)
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: k.vk, code: k.code, key: k.key })
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: k.vk, code: k.code, key: k.key })
}

async function typeText(wc: WebContents, text: string, selector?: string, perKey?: boolean): Promise<void> {
  if (selector) await clickSelector(wc, selector) // focus the field first
  ensureAttached(wc)
  if (perKey) {
    // real per-keystroke events for inputs that listen on keydown (autocomplete, editors)
    for (const ch of text) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    }
  } else {
    // fast path: commit text in one shot (fires input, not keydown/keyup)
    await wc.debugger.sendCommand('Input.insertText', { text })
  }
}

async function read(wc: WebContents, selector?: string): Promise<unknown> {
  return evaluate(
    wc,
    selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText ?? el.textContent ?? '') : null; })()`
      : `({ title: document.title, url: location.href, text: (document.body && document.body.innerText || '').slice(0, 20000) })`
  )
}

async function screenshot(wc: WebContents): Promise<string> {
  ensureAttached(wc)
  const res = (await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true })) as { data: string }
  return res.data // base64 PNG
}

export async function controlWindow(surfaceId: string, action: ControlAction): Promise<ControlResult> {
  try {
    const wc = guestFor(surfaceId)
    switch (action.action) {
      case 'eval':
        if (typeof action.expression !== 'string') throw new Error('eval requires "expression"')
        return { ok: true, result: await evaluate(wc, action.expression) }
      case 'read':
        return { ok: true, result: await read(wc, action.selector) }
      case 'click':
        if (action.selector) await clickSelector(wc, action.selector)
        else if (typeof action.x === 'number' && typeof action.y === 'number') await dispatchClick(wc, action.x, action.y)
        else throw new Error('click requires either "selector" or numeric "x" and "y"')
        return { ok: true }
      case 'type':
        if (typeof action.text !== 'string') throw new Error('type requires "text"')
        await typeText(wc, action.text, action.selector, action.perKey)
        return { ok: true }
      case 'key':
        await pressKey(wc, action.key)
        return { ok: true }
      case 'screenshot':
        return { ok: true, result: await screenshot(wc) }
      default:
        throw new Error('unknown control action')
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
