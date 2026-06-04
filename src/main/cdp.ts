import { webContents, type WebContents } from 'electron'

/**
 * Agent-driven control of live <webview> windows via the Chrome DevTools
 * Protocol. The renderer registers each webview's webContents id (on dom-ready);
 * here in the main process we attach `webContents.debugger` to that guest and
 * dispatch CDP commands. Exposed to the agent through POST /windows/:id/control.
 *
 * This is the "agent controls Google Sheets (or any live web app)" pillar — it
 * works whether the window is on-screen or panned off (backgroundThrottling is
 * forced off for all guests), because CDP drives the WebContents directly.
 */

export type ControlAction =
  | { action: 'eval'; expression: string }
  | { action: 'click'; selector?: string; x?: number; y?: number }
  | { action: 'type'; text: string; selector?: string }
  | { action: 'screenshot' }

export type ControlResult = { ok: true; result?: unknown } | { ok: false; error: string }

// windowId -> guest <webview> webContents id (reported by the renderer on dom-ready)
const registry = new Map<string, number>()

export function registerWebview(windowId: string, webContentsId: number): void {
  registry.set(windowId, webContentsId)
}
export function unregisterWebview(windowId: string): void {
  registry.delete(windowId)
}

function guestFor(windowId: string): WebContents {
  const id = registry.get(windowId)
  if (id === undefined) throw new Error(`no webview registered for window "${windowId}"`)
  const wc = webContents.fromId(id)
  if (!wc || wc.isDestroyed()) {
    registry.delete(windowId)
    throw new Error(`webview for window "${windowId}" is no longer alive`)
  }
  return wc
}

function ensureAttached(wc: WebContents): void {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
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

async function centerOf(wc: WebContents, selector: string): Promise<{ x: number; y: number }> {
  const r = (await evaluate(
    wc,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       const b = el.getBoundingClientRect();
       return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
     })()`
  )) as { x: number; y: number } | null
  if (!r) throw new Error(`selector not found: ${selector}`)
  return r
}

async function clickSelector(wc: WebContents, selector: string): Promise<void> {
  const { x, y } = await centerOf(wc, selector)
  await dispatchClick(wc, x, y)
}

async function typeText(wc: WebContents, text: string, selector?: string): Promise<void> {
  if (selector) await clickSelector(wc, selector) // focus the field first
  ensureAttached(wc)
  // insertText drops text into the focused element; good enough for inputs,
  // textareas and contenteditable without simulating per-key events.
  await wc.debugger.sendCommand('Input.insertText', { text })
}

async function screenshot(wc: WebContents): Promise<string> {
  ensureAttached(wc)
  const res = (await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })) as { data: string }
  return res.data // base64 PNG
}

export async function controlWindow(windowId: string, action: ControlAction): Promise<ControlResult> {
  try {
    const wc = guestFor(windowId)
    switch (action.action) {
      case 'eval':
        if (typeof action.expression !== 'string') throw new Error('eval requires "expression"')
        return { ok: true, result: await evaluate(wc, action.expression) }
      case 'click':
        if (action.selector) await clickSelector(wc, action.selector)
        else if (typeof action.x === 'number' && typeof action.y === 'number') await dispatchClick(wc, action.x, action.y)
        else throw new Error('click requires either "selector" or numeric "x" and "y"')
        return { ok: true }
      case 'type':
        if (typeof action.text !== 'string') throw new Error('type requires "text"')
        await typeText(wc, action.text, action.selector)
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
