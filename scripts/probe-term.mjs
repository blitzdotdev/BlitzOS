// One-shot probe: what do the terminal surfaces ACTUALLY show? Loads the live page, finds every
// .terminal-view (xterm host), reports its bound terminalId (from React surface state) + whether the
// xterm has rendered any text, and screenshots. Answers "why is the terminal blank".
//   node scripts/probe-term.mjs [pageUrl]
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const pageUrl = process.argv[2] || 'http://127.0.0.1:5174'
const profile = mkdtempSync(join(tmpdir(), 'blitz-pterm-'))
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const child = spawn(process.env.CHROMIUM || '/usr/bin/chromium', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
  '--window-size=1600,1000', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
function done(code) { try { child.kill('SIGKILL') } catch {} process.exit(code) }

async function main() {
  const wsUrl = await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('no ws')), 20000); child.stderr.on('data', (d) => { stderr += d; const m = stderr.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); res(m[0]) } }); child.on('exit', (c) => rej(new Error('exit ' + c))) })
  const ws = new WebSocket(wsUrl); let id = 0; const pend = new Map()
  const send = (method, params = {}, sid) => new Promise((res, rej) => { const i = ++id; const to = setTimeout(() => { if (pend.delete(i)) rej(new Error('CDP TO ' + method)) }, 15000); pend.set(i, { res: (v) => { clearTimeout(to); res(v) }, rej }); ws.send(JSON.stringify(sid ? { id: i, method, params, sessionId: sid } : { id: i, method, params })) })
  ws.on('message', (d) => { let m; try { m = JSON.parse(d) } catch { return } if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId)
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: `(()=>{${expr}})()`, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value }
  await send('Page.navigate', { url: pageUrl }, sessionId); await delay(7000)

  const report = await ev(`
    const out = { serverMode: !!window.__BLITZ_SERVER_MODE__, views: [] };
    const views = document.querySelectorAll('.terminal-view');
    out.terminalViewCount = views.length;
    for (const v of views) {
      const rows = v.querySelector('.xterm-rows');
      const text = rows ? (rows.textContent||'').replace(/\\s+/g,' ').trim() : '';
      // walk up to the surface frame to read its title / tabs
      const frame = v.closest('[data-sid]');
      const tabTitles = frame ? Array.from(frame.querySelectorAll('.window-tab, .tab-title, [class*="tab"]')).map(e=>(e.textContent||'').trim()).filter(Boolean).slice(0,6) : [];
      out.views.push({
        sid: frame ? frame.getAttribute('data-sid') : null,
        hasXtermCanvas: !!v.querySelector('canvas, .xterm-rows'),
        textLen: text.length,
        textSample: text.slice(0, 120),
        tabTitles
      });
    }
    // also: are there terminal surfaces at all (the native frame) even w/o a mounted xterm?
    out.terminalFrames = Array.from(document.querySelectorAll('[data-sid]')).filter(f => (f.textContent||'').includes('Terminal') || f.querySelector('.terminal-view')).map(f => f.getAttribute('data-sid'));
    return out;
  `)
  console.log(JSON.stringify(report, null, 2))
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  writeFileSync('/tmp/probe-term.png', Buffer.from(data, 'base64')); console.log('shot → /tmp/probe-term.png')
  ws.close(); done(0)
}
main().catch((e) => { console.error('probe failed:', e.message); done(1) })
