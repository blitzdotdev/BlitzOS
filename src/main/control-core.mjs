/**
 * Transport-agnostic in-window control vocabulary (pure CDP).
 *
 * A `session` is just `{ send(method, params) => Promise<any> }`. This is shared
 * by BOTH run modes so the click/type/key/read/screenshot logic is written once:
 *  - Electron mode: src/main/cdp.ts wraps `webContents.debugger.sendCommand`.
 *  - Server mode:   the Node backend wraps a CDP WebSocket (RemoteCdpSession).
 *
 * Every call here is a stock CDP `send(method, params)` with zero Electron
 * dependency, which is exactly why it drives a <webview> guest and a server-side
 * headless Chromium target identically. Coordinates are CSS pixels (the space
 * Input.dispatch* expects); callers in server mode must map canvas→CSS px first.
 */

async function evaluate(session, expression) {
  const res = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res && res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'evaluation threw')
  return res && res.result ? res.result.value : undefined
}

async function dispatchClick(session, x, y) {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (const type of ['mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
}

async function clickSelector(session, selector) {
  const r = await evaluate(
    session,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       el.scrollIntoView({ block: 'center', inline: 'center' });
       const b = el.getBoundingClientRect();
       return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
     })()`
  )
  if (!r) throw new Error(`selector not found: ${selector}`)
  await dispatchClick(session, r.x, r.y)
}

// Named keys → CDP key fields (the keys that fire real keydown/keyup, which
// Input.insertText does not): Enter/Tab/arrows etc.
const KEYMAP = {
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

async function pressKey(session, name) {
  const k = KEYMAP[name]
  if (!k) throw new Error(`unsupported key "${name}" (supported: ${Object.keys(KEYMAP).join(', ')})`)
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: k.vk, code: k.code, key: k.key })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: k.vk, code: k.code, key: k.key })
}

async function typeText(session, text, selector, perKey) {
  if (selector) await clickSelector(session, selector) // focus the field first
  if (perKey) {
    // real per-keystroke events (text inserts the char; vk so legacy keyCode handlers fire)
    for (const ch of text) {
      const vk = ch.toUpperCase().charCodeAt(0)
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    }
  } else {
    await session.send('Input.insertText', { text }) // fast path: one-shot commit
  }
}

async function read(session, selector) {
  return evaluate(
    session,
    selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText ?? el.textContent ?? '') : null; })()`
      : `({ title: document.title, url: location.href, text: (document.body && document.body.innerText || '').slice(0, 20000) })`
  )
}

async function screenshot(session) {
  const res = await session.send('Page.captureScreenshot', { format: 'png' })
  return res.data // base64 PNG
}

/** Run one control action against a CDP session. Returns {ok,result?} | {ok:false,error}. */
export async function controlSession(session, action) {
  try {
    switch (action.action) {
      case 'eval':
        if (typeof action.expression !== 'string') throw new Error('eval requires "expression"')
        return { ok: true, result: await evaluate(session, action.expression) }
      case 'read':
        return { ok: true, result: await read(session, action.selector) }
      case 'click':
        if (action.selector) await clickSelector(session, action.selector)
        else if (typeof action.x === 'number' && typeof action.y === 'number') await dispatchClick(session, action.x, action.y)
        else throw new Error('click requires either "selector" or numeric "x" and "y"')
        return { ok: true }
      case 'type':
        if (typeof action.text !== 'string') throw new Error('type requires "text"')
        await typeText(session, action.text, action.selector, action.perKey)
        return { ok: true }
      case 'key':
        await pressKey(session, action.key)
        return { ok: true }
      case 'screenshot':
        return { ok: true, result: await screenshot(session) }
      default:
        throw new Error('unknown control action')
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
