// The CHROME tab adapter — via Apple Events `execute … javascript` (extension-free, the connector is deprecated).
// Behind the SAME connection vocabulary as the Safari link: read / run_js / act / navigate. The JS runs in the
// page's own context (Chrome MAIN world), so run_js is unrestricted.
//
// FOCUS-SAFETY IS THE DESIGN CONSTRAINT (measured by a live agent): `execute … javascript` NEVER steals focus
// (0/50 reads, 0/55 navigations via injected location.href). AppleScript `set URL` / `make new tab` / `open`
// stole focus ~30% of the time. So this adapter does EVERYTHING through `execute javascript` — including navigate
// (inject `location.href=…`) — and NEVER touches `set URL` / `open` / `make new tab` on the hot path. The only
// unavoidable steal is opening a site that has no tab yet; that is the user's job (or an explicit foreground act),
// never something this adapter does silently.
//
// Honest caveats (same class as Safari): `execute javascript` is synchronous with NO background event stream (no
// live "source changed" wake — the agent re-reads on demand), and it needs a one-time setup: Chrome ▸ View ▸
// Developer ▸ "Allow JavaScript from Apple Events" + an Automation grant. JS is passed as an osascript ARGUMENT
// (item 1 of argv) so there is no string-escaping to get wrong.

import { READ_JS, ACT_JS, faviconForUrl } from './connection-page-js.mjs'

export function makeChromeAppleScriptLink({ connectionOps, helper } = {}) {
  // EVERY osascript runs THROUGH the computer-use helper so the "control Google Chrome" Automation grant stays on
  // the HELPER (granted once in onboarding) and BlitzOS is NEVER the responsible process for an Apple Event. A
  // direct Electron osascript would run as BlitzOS and re-prompt "control Google Chrome" in every chat session, so
  // there is NO direct-osascript fallback: if the helper can't run it we FAIL (ok:false) and the caller degrades.
  // Ensure the helper first if it isn't up yet (it is prewarmed at boot, so this is usually a no-op).
  const osa = async (args, timeout = 15000) => {
    if (!helper || !helper.available || !helper.available()) {
      return { ok: false, stdout: '', stderr: 'computer-use helper unavailable' }
    }
    if (!helper.connected() && helper.ensure) {
      try { await helper.ensure() } catch { /* reported by the not-connected check below */ }
    }
    if (!helper.connected()) {
      return { ok: false, stdout: '', stderr: 'computer-use helper not connected' }
    }
    const r = await helper.call('osa', { args }, timeout + 2000)
    if (r.error) return { ok: false, stdout: '', stderr: String(r.error) }
    return { ok: !!r.ok, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
  }
  const refToConn = new Map() // dedup: this exact Chrome tab (chrome:w:t) → its connection

  // Run page-context JS in tab t of window w via `execute … javascript`. NEVER navigates via `set URL`.
  async function execJS(code, w, t) {
    const r = await osa([
      '-e', 'on run argv',
      '-e', 'tell application "Google Chrome" to execute (tab (item 2 of argv as integer) of window (item 3 of argv as integer)) javascript (item 1 of argv)',
      '-e', 'end run',
      code, String(t), String(w)
    ])
    if (!r.ok) {
      const msg = r.stderr || 'osascript failed'
      // Chrome's error when the toggle is off OR when Chrome 149+ has a regression where it reports
      // the setting as off even when it's on (the pref file and menu show enabled but execution fails).
      // Do NOT claim the setting is off — it might be on. Give actionable guidance for both cases.
      if (/JavaScript through AppleScript|Allow JavaScript from Apple Events|not allowed|Apple ?events|-1743|automation/i.test(msg)) {
        return { error: 'Chrome denied JavaScript via Apple Events. If View ▸ Developer ▸ "Allow JavaScript from Apple Events" is already checked, Chrome 149 has a regression — do a full Chrome quit-and-relaunch. If unchecked, enable it first. Use the CDP extension or a Drive/Docs MCP connector as an alternative.' }
      }
      return { error: msg.trim() }
    }
    return { stdout: r.stdout.trim() }
  }

  async function listTabs() {
    const r = await osa([
      '-e', 'tell application "Google Chrome"',
      '-e', 'set out to ""',
      '-e', 'repeat with w from 1 to count of windows',
      '-e', 'repeat with t from 1 to count of tabs of window w',
      '-e', 'try',
      '-e', 'set out to out & w & ":" & t & ":" & (URL of tab t of window w) & ":::" & (title of tab t of window w) & linefeed',
      '-e', 'end try',
      '-e', 'end repeat',
      '-e', 'end repeat',
      '-e', 'return out',
      '-e', 'end tell'
    ])
    if (!r.ok) return []
    const tabs = []
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^(\d+):(\d+):(.*?):::(.*)$/)
      if (!m) continue
      const url = m[3]
      const title = m[4]
      // Chrome discards inactive tabs — their URL becomes "about:blank" and title becomes empty.
      // Keep them in the list so the user can see they exist; mark them discarded so the UI can label them.
      // Connecting a discarded tab will reload it and reveal the real URL/title.
      // Only drop genuinely empty lines (no url field at all).
      if (!url) continue
      const discarded = url === 'about:blank' && !title
      tabs.push({
        tabId: `chrome:${m[1]}:${m[2]}`,
        window: Number(m[1]),
        tab: Number(m[2]),
        url: discarded ? '' : url,
        title: discarded ? '' : title,
        favIconUrl: discarded ? undefined : faviconForUrl(url),
        discarded: discarded || undefined
      })
    }
    return tabs
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
    const got = await execJS('(function(){return JSON.stringify({url:location.href,title:document.title})})()', ref.w, ref.t)
    if (got.error) return got
    let info = {}
    try {
      info = JSON.parse(got.stdout)
    } catch {
      /* ignore */
    }
    const sourceId = opts.sourceId || hostOf(info.url || '')
    const adapter = {
      call: async (verb, args) => {
        if (verb === 'run_js') {
          const code = `(function(){try{return JSON.stringify((function(args){${String((args && args.code) || '')}})(${JSON.stringify((args && args.args) || {})}))}catch(e){return JSON.stringify({error:String(e)})}})()`
          const r = await execJS(code, ref.w, ref.t)
          if (r.error) return r
          try {
            const v = JSON.parse(r.stdout)
            return v && v.error ? v : { result: v }
          } catch {
            return { result: r.stdout }
          }
        }
        if (verb === 'read') {
          const r = await execJS(`${READ_JS}(${JSON.stringify(args || {})})`, ref.w, ref.t)
          if (r.error) return r
          try {
            return JSON.parse(r.stdout)
          } catch {
            return { result: r.stdout }
          }
        }
        if (verb === 'act') {
          const r = await execJS(`${ACT_JS}(${JSON.stringify(args || {})})`, ref.w, ref.t)
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
          const r = await execJS(code, ref.w, ref.t)
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
