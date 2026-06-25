// End-to-end driver for jsx/tsx widgets over the REAL agent path (relay create_surface), verified in a
// connected headless chromium. Server mode runs the React renderer in the CLIENT browser, so chromium must
// be connected FIRST — then a created widget hydrates → compiles → mounts. The widget proves its own mount
// by writing back through window.blitz.setProps, so get_surface.props.mounted===true means compile +
// blob-import + esm.sh react@19 + React mount + bridge + persistence all worked.
//   node scripts/drive-jsx-widget.mjs [pageUrl] [backendUrl]
// Leaves the workspace clean (closes everything it created).
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const pageUrl = process.argv[2] || 'http://127.0.0.1:5174'
const backend = process.argv[3] || 'http://127.0.0.1:8799'
const SHOT = process.env.SHOT || '/tmp/jsx-widget.png'
const LOG = '/tmp/jsx-widget-driver.log'
try { writeFileSync(LOG, '') } catch {}
const log = (s) => { try { appendFileSync(LOG, s + '\n') } catch {} ; console.log(s) }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const fails = []
const check = (c, m) => { log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails.push(m) }

// ---- relay: drive tools exactly as a connected agent would ($BASE/<tool>) ----
let BASE = null
async function relayBase() {
  if (BASE) return BASE
  const r = await fetch(`${backend}/api/os/agent-url`).then((x) => x.json()).catch(() => ({}))
  BASE = String(r.url || '').replace(/\/agents\.md$/, '')
  if (!BASE) throw new Error('no relay base (agent socket offline?)')
  return BASE
}
async function tool(name, body) {
  const base = await relayBase()
  return fetch(`${base}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((x) => x.json())
}

// A clock that PROVES its own mount: on first render it writes mounted+reactVersion back through the bridge.
const CLOCK = `import React, { useState, useEffect } from 'react'
export default function Clock() {
  const [p, setP] = useState(blitz.props())
  const [now, setNow] = useState(new Date())
  useEffect(() => { blitz.setProps({ mounted: true, reactVersion: React.version }); blitz.onProps(setP) }, [])
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t) }, [])
  const flip = () => { const format = p.format === '24h' ? '12h' : '24h'; setP({ ...p, format }); blitz.setProps({ format }) }
  return <div data-testid="clock" onClick={flip} style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', cursor:'pointer', fontFamily:'ui-monospace,monospace' }}>
    <div style={{ fontSize: 40, fontWeight: 700 }}>{now.toLocaleTimeString(undefined, { hour12: p.format !== '24h' })}</div>
    <div style={{ fontSize: 11, letterSpacing: '0.18em', textTransform:'uppercase', color:'#888' }}>JSX WIDGET · react {React.version}</div>
  </div>
}`
const BROKEN = `export default function Bad(){ return <div ` // deliberate syntax error

const created = []
let cdp = null

async function main() {
  // 0) connect a renderer FIRST (server mode: the React renderer lives in the browser)
  log('[0] launch chromium + load preview (connect a renderer)')
  cdp = await launchChromium()
  await cdp.send('Page.navigate', { url: pageUrl }, cdp.sessionId)
  await delay(7000) // SSE hydrate + initial render

  // 1) create the good clock via the agent path
  log('[1] create_surface { lang:jsx } via relay')
  const c = await tool('create_surface', { kind: 'srcdoc', lang: 'jsx', title: 'Clock', html: CLOCK, props: { format: '12h' }, w: 320, h: 200 })
  check(!!c.id, 'create returned an id')
  if (c.id) created.push(c.id)
  log('    workspace_path = ' + c.workspace_path)

  // 2) list_state advertises lang:jsx
  log('[2] list_state advertises lang')
  let inList = null
  for (let i = 0; i < 10 && !inList; i++) { await delay(500); const st = await tool('list_state', {}); inList = (st.surfaces || []).find((s) => s.id === c.id) }
  check(!!inList, 'surface present in list_state')
  check(inList && inList.lang === 'jsx', 'list_state shows lang:"jsx" → ' + (inList && inList.lang))

  // 3) PROOF OF MOUNT (a renderer IS connected now): props.mounted written through the bridge
  log('[3] proof-of-mount via the bridge (props.mounted)')
  let full = null
  for (let i = 0; i < 20; i++) { await delay(700); const r = await tool('get_surface', { id: c.id }); const pr = r.surface && r.surface.props; if (pr && pr.mounted) { full = r.surface; break } }
  check(!!full, 'widget wrote props.mounted=true through window.blitz (React mounted in the sandbox)')
  check(full && full.props && /^19\./.test(String(full.props.reactVersion || '')), 'react@19 loaded from esm.sh → ' + (full && full.props && full.props.reactVersion))
  check(!(full && full.props && full.props.lastError), 'no lastError on the good widget')

  // 4) the clock is in the live sandboxed DOM (visual + DOM probe). Center the camera on it first
  //    (it slots off the camera origin), then read it via an auto-attached iframe session.
  log('[4] visual render in chromium')
  await tool('go_to_primary', {})
  await delay(2500)
  try { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, cdp.sessionId); writeFileSync(SHOT, Buffer.from(data, 'base64')); log('    wrote ' + SHOT) } catch (e) { log('    screenshot failed: ' + e.message) }
  const probe = await probeClock()
  check(probe.found, 'clock React component is in the live sandboxed DOM' + (probe.text ? ' → "' + probe.text.slice(0, 48).replace(/\n/g, ' ') + '"' : '') + ' [' + probe.iframes + ' iframe sessions]')

  // 5) error path: a broken jsx surfaces props.lastError (agent-readable)
  log('[5] error path → props.lastError')
  const e = await tool('create_surface', { kind: 'srcdoc', lang: 'jsx', title: 'Bad', html: BROKEN, w: 280, h: 160 })
  if (e.id) created.push(e.id)
  let errSurf = null
  for (let i = 0; i < 14; i++) { await delay(700); const st = await tool('list_state', {}); const s = (st.surfaces || []).find((x) => x.id === e.id); if (s && s.lastError) { errSurf = s; break } }
  check(!!errSurf, 'broken jsx surfaces lastError in list_state')
  check(errSurf && /jsx|token|expect|syntax|unexpected|eof/i.test(String(errSurf.lastError)), 'lastError reads like a compile error → ' + (errSurf && String(errSurf.lastError).slice(0, 80)))

  // cleanup
  log('[cleanup] closing created surfaces')
  for (const id of created) await tool('close_surface', { id })
  await closeCdp(cdp)

  log(fails.length ? `\n${fails.length} FAILURE(S):\n - ` + fails.join('\n - ') : '\nALL E2E CHECKS PASSED')
  process.exit(fails.length ? 1 : 0)
}

async function probeClock() {
  // Sandboxed srcdoc iframes are auto-attached as separate targets (collected in cdp.iframeSessions).
  // Evaluate the clock query inside each; the widget that mounted exposes [data-testid=clock].
  const sessions = [...cdp.iframeSessions]
  for (const sid of sessions) {
    try {
      const ev = await cdp.send('Runtime.evaluate', { expression: "(document.querySelector('[data-testid=clock]')?.innerText)||''", returnByValue: true }, sid)
      if (ev.result && ev.result.value) return { found: true, text: ev.result.value, iframes: sessions.length }
    } catch {}
  }
  return { found: false, text: '', iframes: sessions.length }
}

async function launchChromium() {
  const bin = process.env.CHROMIUM || '/usr/bin/chromium'
  const profile = mkdtempSync(join(tmpdir(), 'blitz-jsxshot-'))
  const child = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-first-run', '--window-size=1400,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let errbuf = ''
  const wsUrl = await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('no ws')), 20000); child.stderr.on('data', (d) => { errbuf += d; const m = errbuf.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); res(m[0]) } }) })
  const ws = new WebSocket(wsUrl)
  let id = 0; const pend = new Map()
  const iframeSessions = new Set()
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pend.set(i, { resolve, reject }); ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params })) })
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d) } catch { return }
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
    // auto-attached subframes (iframes incl. sandboxed srcdoc) arrive as their own sessions
    if (m.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = m.params
      if (targetInfo && (targetInfo.type === 'iframe' || targetInfo.type === 'page')) { iframeSessions.add(sessionId); send('Runtime.enable', {}, sessionId).catch(() => {}) }
    }
  })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  // auto-attach to all child frames (sandboxed srcdoc iframes show up here, not in getFrameTree)
  await send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }, sessionId)
  return { ws, child, send, sessionId, iframeSessions }
}

// Graceful teardown: Browser.close lets chromium reap its OWN renderer children, so they never orphan
// to PID 1 (in this sandbox PID 1 is `sleep infinity` and never reaps → SIGKILL leaks zombie subprocesses).
// Detached spawn + a process-GROUP kill is only the timeout fallback.
async function closeCdp(cdp) {
  if (!cdp) return
  try { cdp.send('Browser.close').catch(() => {}) } catch {}
  await new Promise((r) => {
    let done = false; const fin = () => { if (!done) { done = true; r() } }
    cdp.child.once('exit', fin)
    setTimeout(() => { if (!done) { try { process.kill(-cdp.child.pid, 'SIGKILL') } catch { try { cdp.child.kill('SIGKILL') } catch {} } fin() } }, 3000)
  })
  try { cdp.ws.close() } catch {}
}

main().catch(async (e) => { log('DRIVER ERROR: ' + (e.stack || e.message)); await closeCdp(cdp); process.exit(2) })
