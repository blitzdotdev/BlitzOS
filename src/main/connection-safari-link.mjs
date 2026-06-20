// The SAFARI tab adapter — via Apple Events `do JavaScript` (Safari is scriptable; it can't be force-installed
// with an extension). Behind the SAME connection vocabulary as Chrome tabs: read / run_js / act-by-ref. The JS
// runs in the page's own context (like Chrome MAIN world), so run_js is unrestricted (no page-CSP limit).
//
// Honest caveat (the design's): `do JavaScript` is synchronous/blocking and has NO background event stream —
// so a Safari connection has no live "source changed" wake (the agent re-reads on demand), and it needs a
// one-time setup (Safari ▸ Develop ▸ "Allow JavaScript from Apple Events" + an Automation grant). The JS is
// passed as an osascript ARGUMENT (item 1 of argv) so there is no string-escaping to get wrong.

import { execFile } from 'node:child_process'

const osa = (args, timeout = 15000) =>
  new Promise((resolve) =>
    execFile('/usr/bin/osascript', args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    )
  )

// page-context JS (a string Safari evaluates); each returns a JSON string we parse back.
const READ_JS =
  "(function(a){var sel=a&&a.selector;var root=sel?document.querySelector(sel):document.body;if(!root)return JSON.stringify({error:'no match for '+sel});var max=(a&&a.max)||8000;return JSON.stringify({url:location.href,title:document.title,text:(root.innerText||'').slice(0,max)})})"
const ACT_JS =
  "(function(a){var el=a.selector?document.querySelector(a.selector):document.activeElement;if(a.action==='click'){if(!el)return JSON.stringify({error:'no match for '+a.selector});el.click();return JSON.stringify({effect:{clicked:a.selector||true,url:location.href}})}if(a.action==='set'||a.action==='type'){if(!el)return JSON.stringify({error:'no match for '+a.selector});if('value' in el){el.value=a.text==null?'':''+a.text;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify({effect:{value:el.value}})}el.textContent=a.text==null?'':''+a.text;return JSON.stringify({effect:{value:el.textContent}})}if(a.action==='key'){var t=el||document.activeElement||document.body;t.dispatchEvent(new KeyboardEvent('keydown',{key:a.key,bubbles:true}));t.dispatchEvent(new KeyboardEvent('keyup',{key:a.key,bubbles:true}));return JSON.stringify({effect:{key:a.key}})}return JSON.stringify({error:'unknown action '+a.action})})"

export function makeSafariLink({ connectionOps } = {}) {
  const refToConn = new Map() // dedup: this exact Safari tab (safari:w:t) → its connection
  async function doJS(code, w, t) {
    const r = await osa([
      '-e', 'on run argv',
      '-e', 'tell application "Safari" to do JavaScript (item 1 of argv) in tab (item 2 of argv as integer) of window (item 3 of argv as integer)',
      '-e', 'end run',
      code, String(t), String(w)
    ])
    if (!r.ok) {
      const msg = r.stderr || 'osascript failed'
      if (/not allowed|Apple ?events|-1743|assistive|automation|do JavaScript/i.test(msg)) {
        return { error: 'Safari blocked Apple Events — enable Safari ▸ Develop ▸ "Allow JavaScript from Apple Events" and grant Automation to BlitzOS, then retry' }
      }
      return { error: msg.trim() }
    }
    return { stdout: r.stdout.trim() }
  }

  async function listTabs() {
    const r = await osa([
      '-e', 'tell application "Safari"',
      '-e', 'set out to ""',
      '-e', 'repeat with w from 1 to count of windows',
      '-e', 'repeat with t from 1 to count of tabs of window w',
      '-e', 'try',
      '-e', 'set out to out & w & ":" & t & ":" & (URL of tab t of window w) & ":::" & (name of tab t of window w) & linefeed',
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
      if (!/^https?:/i.test(url)) continue
      tabs.push({ tabId: `safari:${m[1]}:${m[2]}`, window: Number(m[1]), tab: Number(m[2]), url, title: m[4] })
    }
    return tabs
  }

  function parseRef(id) {
    const m = String(id).match(/^safari:(\d+):(\d+)$/)
    return m ? { w: Number(m[1]), t: Number(m[2]) } : null
  }
  function hostOf(url) {
    try {
      return new URL(url).host || 'safari-tab'
    } catch {
      return 'safari-tab'
    }
  }

  async function connectTab(tabId, opts = {}) {
    const ref = parseRef(tabId)
    if (!ref) return { error: 'bad Safari tab id (expected safari:<window>:<tab>)' }
    // DEDUP: this exact Safari tab is already connected (and live) → re-attach, don't spawn a duplicate.
    const existing = refToConn.get(String(tabId))
    if (existing && typeof connectionOps.connectionIsLive === 'function' && connectionOps.connectionIsLive(existing)) {
      const info = connectionOps.connectionInfo(existing)
      if (info) {
        // re-attaching an already-live Safari tab from a (possibly different) chat → transfer ownership so it lists
        // in THIS chat's dropbox + wakes this chat's agent, instead of staying owned by the first chat and vanishing.
        if (typeof connectionOps.connectionSetOwner === 'function') connectionOps.connectionSetOwner(existing, opts.agentId)
        return { ...info, tab: { tabId } }
      }
    }
    const got = await doJS('(function(){return JSON.stringify({url:location.href,title:document.title})})()', ref.w, ref.t)
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
          const r = await doJS(code, ref.w, ref.t)
          if (r.error) return r
          try {
            const v = JSON.parse(r.stdout)
            return v && v.error ? v : { result: v }
          } catch {
            return { result: r.stdout }
          }
        }
        if (verb === 'read') {
          const r = await doJS(`${READ_JS}(${JSON.stringify(args || {})})`, ref.w, ref.t)
          if (r.error) return r
          try {
            return JSON.parse(r.stdout)
          } catch {
            return { result: r.stdout }
          }
        }
        if (verb === 'act') {
          const r = await doJS(`${ACT_JS}(${JSON.stringify(args || {})})`, ref.w, ref.t)
          if (r.error) return r
          try {
            return JSON.parse(r.stdout)
          } catch {
            return { effect: r.stdout }
          }
        }
        return { error: `verb "${verb}" not supported for a Safari tab` }
      },
      drop: () => {}
    }
    const bound = connectionOps.connectionBind({ type: 'tab', sourceId, title: opts.title || info.title || sourceId, capabilities: { run_js: true, act: true }, adapter, ref: String(tabId), agentId: opts.agentId })
    refToConn.set(String(tabId), bound.connId)
    adapter.drop = () => {
      if (refToConn.get(String(tabId)) === bound.connId) refToConn.delete(String(tabId))
    }
    return { connId: bound.connId, surfaceId: bound.surfaceId, sourceId, tab: { tabId, url: info.url, title: info.title } }
  }

  return { listTabs, connectTab }
}
