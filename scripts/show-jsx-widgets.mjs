// Showcase v2: four JSX widgets redesigned to the HOUSE design bar (profile.html): accent kicker,
// tight hero type, tiny caps labels, tokens everywhere (no hardcoded hex), one hero each. Plus the
// SVG-token gotchas handled — recharts reads --blitz-accent via getComputedStyle; lucide themes via
// CSS currentColor (style, not the color attr). Renders them in a fresh workspace and screenshots.
//   node scripts/show-jsx-widgets.mjs [pageUrl] [backendUrl]
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const pageUrl = process.argv[2] || 'http://127.0.0.1:5174'
const backend = process.argv[3] || 'http://127.0.0.1:8799'
const SHOT = process.env.SHOT || '/tmp/jsx-showcase.png'
const WS = process.env.WS_NAME || 'Dashboard'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
let BASE = null
async function tool(name, body) {
  if (!BASE) { const r = await fetch(`${backend}/api/os/agent-url`).then((x) => x.json()); BASE = String(r.url || '').replace(/\/agents\.md$/, '') }
  return fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((x) => x.json())
}

const KICK = "font:'600 9px ui-monospace,monospace',letterSpacing:'.18em',textTransform:'uppercase',color:'var(--blitz-accent)'"
const WIDGETS = [
  { title: 'Revenue · recharts', marker: 'REVENUE', src: `
import React from 'react'
import { AreaChart, Area, ResponsiveContainer } from 'recharts'
const data = [40,46,42,58,53,71,66,85,80,97].map((v,i)=>({i,v}))
export default function Revenue(){
  const accent = (getComputedStyle(document.documentElement).getPropertyValue('--blitz-accent')||'#e31c30').trim()
  return <div data-testid="w" style={{position:'relative',height:'100%',display:'flex',flexDirection:'column',padding:'18px 18px 0',boxSizing:'border-box',overflow:'hidden'}}>
    <div style={{${KICK}}}>Revenue · 30d</div>
    <div style={{display:'flex',alignItems:'baseline',gap:9,marginTop:9}}>
      <div style={{fontSize:34,fontWeight:700,letterSpacing:'-.03em',lineHeight:1,fontVariantNumeric:'tabular-nums'}}>$48.2k</div>
      <div style={{fontSize:12,fontWeight:600,color:'#16a34a'}}>▲ 12.4%</div>
    </div>
    <div style={{position:'absolute',left:0,right:0,bottom:0,height:'46%'}}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{top:2,right:0,bottom:0,left:0}}>
          <defs><linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={0.28}/><stop offset="100%" stopColor={accent} stopOpacity={0}/>
          </linearGradient></defs>
          <Area type="monotone" dataKey="v" stroke={accent} strokeWidth={2.5} fill="url(#rev)"/>
        </AreaChart>
      </ResponsiveContainer>
    </div>
  </div>
}` },
  { title: 'Signups · framer-motion', marker: 'SIGNUPS', src: `
import React, { useEffect } from 'react'
import { motion, useSpring, useTransform } from 'framer-motion'
export default function Signups(){
  const v = useSpring(0,{stiffness:48,damping:18})
  const n = useTransform(v,x=>Math.round(x).toLocaleString())
  const w = useTransform(v,x=>Math.min(100,x/3200*100)+'%')
  useEffect(()=>{ v.set(2847) },[])
  return <div data-testid="w" style={{height:'100%',display:'flex',flexDirection:'column',justifyContent:'center',gap:11,padding:'0 20px',boxSizing:'border-box'}}>
    <div style={{${KICK}}}>Signups · 30d</div>
    <motion.div style={{fontSize:44,fontWeight:700,letterSpacing:'-.03em',lineHeight:1,fontVariantNumeric:'tabular-nums'}}>{n}</motion.div>
    <div style={{height:5,borderRadius:5,background:'var(--blitz-hairline)',overflow:'hidden'}}>
      <motion.div style={{height:'100%',width:w,background:'var(--blitz-accent)'}}/>
    </div>
    <div style={{fontSize:11,color:'var(--blitz-text-dim)'}}><span style={{color:'#16a34a',fontWeight:600}}>▲ 18%</span> vs last month</div>
  </div>
}` },
  { title: 'System · lucide', marker: 'SYSTEM', src: `
import React from 'react'
import { Activity, Database, Globe, RefreshCw } from 'lucide-react'
const rows=[{I:Activity,l:'CPU load',v:'42%'},{I:Database,l:'Database',v:'Healthy'},{I:Globe,l:'Network',v:'1.2 Gb/s'},{I:RefreshCw,l:'Sync',v:'Live'}]
export default function System(){
  return <div data-testid="w" style={{height:'100%',display:'flex',flexDirection:'column',padding:'16px 18px',boxSizing:'border-box'}}>
    <div style={{${KICK},marginBottom:4}}>System</div>
    <div style={{display:'flex',flexDirection:'column',flex:1}}>
      {rows.map(({I,l,v},i)=>(<div key={l} style={{display:'flex',alignItems:'center',gap:11,flex:1,borderTop:i?'1px solid var(--blitz-hairline)':'none'}}>
        <I size={16} strokeWidth={2} style={{color:'var(--blitz-accent)',flex:'0 0 auto'}}/>
        <div style={{flex:1,fontSize:12.5}}>{l}</div>
        <div style={{fontSize:12.5,fontWeight:700,letterSpacing:'-.01em',fontVariantNumeric:'tabular-nums'}}>{v}</div>
      </div>))}
    </div>
  </div>
}` },
  { title: 'Release · react-markdown', marker: 'RELEASE', src: `
import React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
const md = '## Release 0.2\\n\\nShipped **JSX widgets** — React at runtime.\\n\\n- charts, springs, markdown\\n- ~~build step~~ zero build\\n- forkable single file'
const C = {
  h2:({children})=> <div style={{${KICK},marginBottom:10}}>{children}</div>,
  p:({children})=> <p style={{margin:'0 0 10px',fontSize:13,lineHeight:1.55}}>{children}</p>,
  ul:({children})=> <ul style={{margin:0,paddingLeft:15,fontSize:12.5,lineHeight:1.75}}>{children}</ul>,
  del:({children})=> <del style={{color:'var(--blitz-text-dim)'}}>{children}</del>
}
export default function Release(){
  return <div data-testid="w" style={{height:'100%',padding:'16px 18px',boxSizing:'border-box',overflow:'auto',color:'var(--blitz-text)'}}>
    <Markdown remarkPlugins={[remarkGfm]} components={C}>{md}</Markdown>
  </div>
}` }
]

async function main() {
  console.log('[1] fresh workspace "' + WS + '"')
  await tool('create_workspace', { name: WS }); await tool('switch_workspace', { name: WS }); await delay(1500)
  console.log('[2] create the four widgets')
  for (const w of WIDGETS) { const r = await tool('create_surface', { kind: 'srcdoc', lang: 'jsx', title: w.title, html: w.src, w: 320, h: 210 }); console.log('    + ' + w.title + ' → ' + (r.id ? 'ok' : JSON.stringify(r))) }
  console.log('[3] connect chromium → render')
  const cdp = await launchChromium()
  await cdp.send('Page.navigate', { url: pageUrl }, cdp.sessionId)
  await delay(6000); await tool('go_to_primary', {}); await delay(14000)
  try { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, cdp.sessionId); writeFileSync(SHOT, Buffer.from(data, 'base64')); console.log('    wrote ' + SHOT) } catch (e) { console.log('    shot failed: ' + e.message) }
  console.log('[4] confirm each drew')
  const texts = []
  for (const sid of [...cdp.iframeSessions]) { try { const ev = await cdp.send('Runtime.evaluate', { expression: "(document.querySelector('[data-testid=w]')?.innerText)||''", returnByValue: true }, sid); if (ev.result && ev.result.value) texts.push(ev.result.value.replace(/\s+/g, ' ').trim()) } catch {} }
  for (const w of WIDGETS) { const hit = texts.find((t) => t.toUpperCase().includes(w.marker)); console.log((hit ? '  ✓ ' : '  ✗ ') + w.title + (hit ? ' → "' + hit.slice(0, 50) + '"' : ' (missing)')) }
  await closeCdp(cdp)
  console.log('\nleft up on the "' + WS + '" workspace.')
}

// Graceful teardown — Browser.close lets chromium reap its renderer children (PID 1 here is `sleep` and
// never reaps, so SIGKILL would orphan them as permanent zombies). Group-kill is only the fallback.
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

async function launchChromium() {
  const bin = process.env.CHROMIUM || '/usr/bin/chromium'
  const profile = mkdtempSync(join(tmpdir(), 'blitz-show-'))
  const child = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-first-run', '--window-size=1500,950', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let eb = ''
  const wsUrl = await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('no ws')), 20000); child.stderr.on('data', (d) => { eb += d; const m = eb.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); res(m[0]) } }) })
  const ws = new WebSocket(wsUrl)
  let id = 0; const pend = new Map(); const iframeSessions = new Set()
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pend.set(i, { resolve, reject }); ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params })) })
  ws.on('message', (d) => { let m; try { m = JSON.parse(d) } catch { return } if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } if (m.method === 'Target.attachedToTarget') { const { sessionId, targetInfo } = m.params; if (targetInfo && targetInfo.type === 'iframe') { iframeSessions.add(sessionId); send('Runtime.enable', {}, sessionId).catch(() => {}) } } })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId)
  await send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }, sessionId)
  return { ws, child, send, sessionId, iframeSessions }
}
main().catch((e) => { console.error('ERROR', e.stack || e.message); process.exit(1) })
