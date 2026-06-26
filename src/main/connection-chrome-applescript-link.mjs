// The CHROME tab adapter — drives the USER's Chrome tabs via the helper's PID-pinned ScriptingBridge path
// (`chrome_js` / `chrome_list_tabs`), NOT `tell application "Google Chrome"`. Behind the SAME connection vocabulary
// as the Safari link: read / run_js / act / navigate.
//
// WHY PID-PINNED (the bug this fixes): `tell application "Google Chrome"` resolves by bundle id, which is AMBIGUOUS
// when BlitzOS's own "Blitz Chrome" (a second com.google.Chrome instance, blitz-chrome.ts) is alive — the Apple
// Event can route to the wrong instance, so the user's tabs vanish or a tab index throws -1719 and the agent wrongly
// concludes the tab is closed. The helper pins the Apple Event to the USER's Chrome PID (excluding Blitz's pid),
// removing the ambiguity. TCC is UNCHANGED: Apple Events auth is keyed by the TARGET bundle id, not pid, so the
// helper's existing "control Google Chrome" grant covers it with no new prompt. See plans/blitzos-chrome-pid-targeting.md.
//
// FOCUS-SAFETY (measured by a live agent): `execute … javascript` NEVER steals focus. So this adapter does
// EVERYTHING through it — including navigate (inject `location.href=…`) — and NEVER touches `set URL` / `open` /
// `make new tab`. The only unavoidable steal is opening a site that has no tab yet; that is the user's job.
//
// ROBUST ADDRESSING: a connection binds to the tab's STABLE Chrome `id` (captured on connect), re-resolved by id on
// every call, so a window reorder / focus change / tab move can't silently re-point it at the WRONG tab. Falls back
// to the 1-based window/tab index when the id isn't available — never worse than the old positional behavior.
//
// Honest caveat (same as Safari): no background event stream (the agent re-reads on demand), and a one-time setup:
// Chrome ▸ View ▸ Developer ▸ "Allow JavaScript from Apple Events" + an Automation grant on the helper.

import { READ_JS, ACT_JS, faviconForUrl } from './connection-page-js.mjs'
import { classifyBrowserState, browserListTabsGate } from './connection-grants.mjs'

export function makeChromeAppleScriptLink({ connectionOps, helper, blitzPid } = {}) {
  // Blitz Chrome's real browser pid, to EXCLUDE from the user-Chrome enumeration (so the agent's own browser never
  // shadows the user's). -1 = nothing to exclude (Blitz not running / pid not resolved yet).
  const getBlitzPid = () => {
    try {
      const p = typeof blitzPid === 'function' ? blitzPid() : null
      return typeof p === 'number' && p > 0 ? p : -1
    } catch {
      return -1
    }
  }
  const refToConn = new Map() // dedup: this exact Chrome tab (chrome:w:t) → its connection

  // Every Chrome helper RPC goes through here so the availability/ensure checks live in ONE place. There is NO
  // direct-osascript fallback: the Automation grant must stay on the HELPER (else BlitzOS re-prompts every session),
  // so if the helper can't run it we FAIL (the caller degrades).
  const hcall = async (cmd, payload = {}, timeout = 20000) => {
    if (!helper || !helper.available || !helper.available()) return { error: 'computer-use helper unavailable' }
    if (!helper.connected() && helper.ensure) {
      try { await helper.ensure() } catch { /* reported by the not-connected check below */ }
    }
    if (!helper.connected()) return { error: 'computer-use helper not connected' }
    const r = await helper.call(cmd, payload, timeout)
    return r || { error: 'no reply from helper' }
  }

  // Run page-context JS in a user-Chrome tab (by stable `id` if known, else window/tab index). Returns
  // { stdout, id } (id = the resolved tab's STABLE id, so the caller can bind to it) or { error }.
  async function chromeJS(code, { id, w, t } = {}) {
    // `tabId` (NOT `id`) on the wire — the helper socket reserves `id` for message correlation.
    const r = await hcall('chrome_js', { excludePid: getBlitzPid(), code, ...(id != null ? { tabId: id } : { window: w, tab: t }) })
    if (r.error || r.ok === false) {
      if (r.reason === 'no-user-chrome') return { error: "Google Chrome isn't running" }
      const msg = String(r.error || r.reason || 'chrome_js failed')
      // Chrome's error when the Allow-JS toggle is off OR the Chrome 149+ regression (reports off even when on).
      // Do NOT claim the setting is off — give actionable guidance for both cases.
      if (/JavaScript through AppleScript|Allow JavaScript from Apple Events|not allowed|Apple ?events|-1743|automation|turned off/i.test(msg)) {
        return { error: 'Chrome denied JavaScript via Apple Events. If View ▸ Developer ▸ "Allow JavaScript from Apple Events" is already checked, Chrome 149 has a regression — do a full Chrome quit-and-relaunch. If unchecked, enable it first. Use the CDP extension or a Drive/Docs MCP connector as an alternative.' }
      }
      return { error: msg.trim() }
    }
    return { stdout: String(r.result ?? '').trim(), id: typeof r.tabId === 'number' && r.tabId >= 0 ? r.tabId : undefined }
  }

  async function listTabs() {
    // NO-PROMPT gate: only send the (prompting) Apple Event when the helper ALREADY holds "control Google Chrome".
    // A passive poll must NEVER raise the consent dialog — it pops UNDER the picker overlay, unclickable. When not
    // granted, report the connector state from the no-prompt status so the UI shows a grant row (no prompt fires).
    const auth = helper && helper.automationGranted ? await helper.automationGranted('com.google.Chrome').catch(() => 'unknown') : 'granted'
    const gate = browserListTabsGate(auth)
    if (gate) return { tabs: [], state: gate }
    const r = await hcall('chrome_list_tabs', { excludePid: getBlitzPid() }, 15000)
    if (r.error || r.ok === false) {
      // No user Chrome running is a DISTINCT, honest result (not a permission gap) → 'unreachable'.
      if (r.reason === 'no-user-chrome') return { tabs: [], state: 'unreachable' }
      return { tabs: [], state: classifyBrowserState(String(r.error || '')) }
    }
    const tabs = []
    for (const row of Array.isArray(r.tabs) ? r.tabs : []) {
      const url = String(row.url || '')
      // Chrome discards inactive tabs — URL becomes "about:blank", title empty. Keep them (so the user sees they
      // exist) but mark discarded; connecting one reloads it. Only drop rows with no url field at all.
      if (!url) continue
      const title = String(row.title || '')
      const discarded = url === 'about:blank' && !title
      tabs.push({
        tabId: `chrome:${row.window}:${row.tab}`,
        window: Number(row.window),
        tab: Number(row.tab),
        chromeId: typeof row.id === 'number' && row.id >= 0 ? row.id : undefined, // stable id the connection binds to
        url: discarded ? '' : url,
        title: discarded ? '' : title,
        favIconUrl: discarded ? undefined : faviconForUrl(url),
        discarded: discarded || undefined
      })
    }
    return { tabs, state: 'ok' }
  }

  function parseRef(id) {
    const m = String(id).match(/^chrome:(\d+):(\d+)$/)
    return m ? { w: Number(m[1]), t: Number(m[2]) } : null
  }
  function hostOf(url) {
    try {
      return new URL(url).host || 'chrome-tab'
    } catch {
      return 'chrome-tab'
    }
  }

  async function connectTab(tabId, opts = {}) {
    const ref = parseRef(tabId)
    if (!ref) return { error: 'bad Chrome tab id (expected chrome:<window>:<tab>)' }
    // DEDUP: this exact Chrome tab is already connected (and live) → re-attach, don't spawn a duplicate.
    const existing = refToConn.get(String(tabId))
    if (existing && typeof connectionOps.connectionIsLive === 'function' && connectionOps.connectionIsLive(existing)) {
      const info = connectionOps.connectionInfo(existing)
      if (info) {
        if (typeof connectionOps.connectionSetOwner === 'function') connectionOps.connectionSetOwner(existing, opts.agentId)
        return { ...info, tab: { tabId } }
      }
    }
    // Initial read by window/tab index — this ALSO captures the tab's STABLE Chrome id, which the connection binds
    // to so later calls survive a window reorder / tab move (the positional-drift root cause).
    const got = await chromeJS('(function(){return JSON.stringify({url:location.href,title:document.title})})()', { w: ref.w, t: ref.t })
    if (got.error) return got
    let info = {}
    try {
      info = JSON.parse(got.stdout)
    } catch {
      /* ignore */
    }
    // The bound stable id. Re-confirmed from every call's reply (in case it was unknown at connect). When null we
    // fall back to the window/tab ordinal — never worse than the old behavior.
    let chromeId = got.id
    const target = () => (chromeId != null ? { id: chromeId } : { w: ref.w, t: ref.t })
    const runVerb = async (code) => {
      const r = await chromeJS(code, target())
      if (!r.error && r.id != null) chromeId = r.id
      return r
    }
    const sourceId = opts.sourceId || hostOf(info.url || '')
    const adapter = {
      call: async (verb, args) => {
        if (verb === 'run_js') {
          const code = `(function(){try{return JSON.stringify((function(args){${String((args && args.code) || '')}})(${JSON.stringify((args && args.args) || {})}))}catch(e){return JSON.stringify({error:String(e)})}})()`
          const r = await runVerb(code)
          if (r.error) return r
          try {
            const v = JSON.parse(r.stdout)
            return v && v.error ? v : { result: v }
          } catch {
            return { result: r.stdout }
          }
        }
        if (verb === 'read') {
          const r = await runVerb(`${READ_JS}(${JSON.stringify(args || {})})`)
          if (r.error) return r
          try {
            return JSON.parse(r.stdout)
          } catch {
            return { result: r.stdout }
          }
        }
        if (verb === 'act') {
          const r = await runVerb(`${ACT_JS}(${JSON.stringify(args || {})})`)
          if (r.error) return r
          try {
            return JSON.parse(r.stdout)
          } catch {
            return { effect: r.stdout }
          }
        }
        if (verb === 'navigate') {
          // FOCUS-SAFE navigation: inject location.href in-page. NEVER `set URL of tab` (that steals focus).
          const url = String((args && args.url) || '')
          if (!url) return { error: 'navigate needs a url' }
          const code = `(function(u){location.href=u;return JSON.stringify({navigated:u})})(${JSON.stringify(url)})`
          const r = await runVerb(code)
          if (r.error) return r
          return { effect: { navigated: url } }
        }
        return { error: `verb "${verb}" not supported for a Chrome tab` }
      },
      drop: () => {}
    }
    const bound = connectionOps.connectionBind({ type: 'tab', sourceId, title: opts.title || info.title || sourceId, capabilities: { run_js: true, act: true }, adapter, ref: String(tabId), agentId: opts.agentId, origin: 'user-chrome' })
    refToConn.set(String(tabId), bound.connId)
    adapter.drop = () => {
      if (refToConn.get(String(tabId)) === bound.connId) refToConn.delete(String(tabId))
    }
    return { connId: bound.connId, surfaceId: bound.surfaceId, sourceId, tab: { tabId, url: info.url, title: info.title } }
  }

  return { listTabs, connectTab }
}
