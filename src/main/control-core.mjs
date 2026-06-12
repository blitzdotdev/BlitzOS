/**
 * Transport-agnostic in-window control vocabulary (pure CDP).
 *
 * A `session` is just `{ send(method, params) => Promise<any> }`. This is shared
 * by BOTH run modes so the click/type/key/read/screenshot logic is written once:
 *  - Electron mode: src/main/cdp.ts wraps `webContents.debugger.sendCommand`.
 *  - Server mode:   the Node backend wraps a CDP WebSocket (RemoteCdpSession).
 *
 * Every call here is a stock CDP `send(method, params)` with zero Electron
 * dependency, which is exactly why it drives an Electron browser guest and a server-side
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

// Resolve a selector to an ACTIONABLE click point. The naive `querySelector` → first match is a real
// hazard: sites keep hidden/duplicate copies of a control in the DOM (Gmail's Send button has a hidden
// twin), so the first match is often not the one a human would click — and clicking it silently does
// nothing. We enumerate ALL matches and keep the first that is (1) nonzero-size, (2) scrolled into view,
// and (3) the hit-test WINNER at its own center (elementFromPoint returns it or a descendant — i.e. not
// covered by an overlay). Returns the point, or a diagnostic so the caller can throw a TRUE error
// ("matched N but none clickable") instead of returning ok on a no-op.
async function resolveClickPoint(session, selector) {
  return evaluate(
    session,
    `(() => {
       const sel = ${JSON.stringify(selector)};
       const all = [...document.querySelectorAll(sel)];
       if (!all.length) return { found: 0 };
       for (const el of all) {
         const b0 = el.getBoundingClientRect();
         if (b0.width < 1 || b0.height < 1) continue;            // zero-size / display:none-ish
         el.scrollIntoView({ block: 'center', inline: 'center' });
         const b = el.getBoundingClientRect();
         const x = b.left + b.width / 2, y = b.top + b.height / 2;
         if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue; // off-screen after scroll
         const hit = document.elementFromPoint(x, y);
         if (hit && (hit === el || el.contains(hit) || hit.contains(el))) return { found: all.length, x, y };
       }
       return { found: all.length, blocked: true };              // matched, but every one hidden/covered
     })()`
  )
}

async function clickSelector(session, selector) {
  const r = await resolveClickPoint(session, selector)
  if (!r || !r.found) throw new Error(`selector not found: ${selector}`)
  if (r.blocked || typeof r.x !== 'number') throw new Error(`selector "${selector}" matched ${r.found} element(s) but none are clickable (hidden, zero-size, or covered by another element)`)
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
  // 2B: read the focused field's ACTUAL value back, so the agent sees what landed (wrong field /
  // partial input / a control that swallowed the text are all visible without a screenshot).
  return evaluate(
    session,
    `(() => { const ae = document.activeElement; if (!ae) return null;
       const v = ae.value != null ? ae.value : (ae.isContentEditable ? ae.innerText : null);
       return v == null ? null : { tag: ae.tagName, value: String(v).slice(0, 500) }; })()`
  ).catch(() => null)
}

// A cheap pre/post fingerprint of the page so an action can REPORT its effect (2B): the agent verifies
// in-band ("did anything happen?") without a second screenshot round-trip. Content-agnostic — url +
// focused element + a body-length proxy for "the DOM changed". Never throws (effect reporting must not
// fail an otherwise-good action).
async function snapshotState(session) {
  try {
    return await evaluate(
      session,
      `(() => {
         const ae = document.activeElement;
         const focused = ae && ae !== document.body ? { tag: ae.tagName, type: (ae.getAttribute && ae.getAttribute('type')) || null, name: ae.getAttribute && (ae.getAttribute('aria-label') || ae.name || ae.id) || null } : null;
         return { url: location.href, len: (document.body && document.body.innerText || '').length, focused };
       })()`
    )
  } catch {
    return null
  }
}
/** Diff two snapshots into a small, generic effect object for the action result. */
function diffEffect(before, after) {
  if (!after) return undefined
  const e = { urlChanged: !!(before && after && before.url !== after.url), domChanged: !!(before && after && before.len !== after.len) }
  if (after.focused) e.focused = after.focused
  if (after.url) e.url = after.url
  return e
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
      case 'click': {
        if (!action.selector && !(typeof action.x === 'number' && typeof action.y === 'number')) throw new Error('click requires either "selector" or numeric "x" and "y"')
        const before = await snapshotState(session)
        if (action.selector) await clickSelector(session, action.selector)
        else await dispatchClick(session, action.x, action.y)
        await new Promise((r) => setTimeout(r, 60)) // let a nav/DOM reaction begin before we sample
        return { ok: true, effect: diffEffect(before, await snapshotState(session)) }
      }
      case 'type': {
        if (typeof action.text !== 'string') throw new Error('type requires "text"')
        const value = await typeText(session, action.text, action.selector, action.perKey)
        // The effect IS the field readback (2B): the agent confirms what actually landed.
        return value ? { ok: true, effect: { value: value.value, typedInto: value.tag } } : { ok: true }
      }
      case 'key': {
        const before = await snapshotState(session)
        await pressKey(session, action.key)
        await new Promise((r) => setTimeout(r, 60))
        return { ok: true, effect: diffEffect(before, await snapshotState(session)) }
      }
      case 'screenshot':
        return { ok: true, result: await screenshot(session) }
      default:
        throw new Error('unknown control action')
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
