// CDP + relay driver: verify stage-per-agent end to end.
//  (1) self-heal — existing agent chats hydrate into their own stages (chat-N in stage N);
//  (2) a NEW agent's chat + its agent-created surface + its terminal all land in the agent's stage,
//      while the user's primary stage (0) is undisturbed.
//   node scripts/drive-stages.mjs [pageUrl] [backendUrl]
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const pageUrl = process.argv[2] || 'https://agentos.blitzmen.com'
const backend = process.argv[3] || 'http://127.0.0.1:8799'
const [W, H] = [1600, 1000]
const bin = process.env.CHROMIUM || '/usr/bin/chromium'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'blitz-stages-'))
const fails = []
const check = (cond, label) => { console.log((cond ? '  ✓ ' : '  ✗ ') + label); if (!cond) fails.push(label) }

// Resolve the agent-socket tool base ($BASE/<tool>) from the running backend, then drive tools via node fetch.
async function relay(tool, body) {
  const r = await fetch(`${backend}/api/os/agent-url`).then((x) => x.json()).catch(() => ({}))
  const base = String(r.url || '').replace(/\/agents\.md$/, '')
  if (!base) throw new Error('no agent base')
  return fetch(`${base}/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((x) => x.json()).catch(() => null)
}

const child = spawn(bin, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  `--window-size=${W},${H}`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
function cleanup(code) { try { child.kill('SIGKILL') } catch { /* gone */ } process.exit(code) }

async function main() {
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no DevTools ws')), 20000)
    child.stderr.on('data', (d) => { stderr += d; const m = stderr.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(timer); resolve(m[0]) } })
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error('chromium exited ' + c)) })
  })
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id
    const to = setTimeout(() => { if (pending.delete(i)) reject(new Error('CDP timeout: ' + method)) }, 15000)
    pending.set(i, { resolve: (v) => { clearTimeout(to); resolve(v) }, reject: (e) => { clearTimeout(to); reject(e) } })
    ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }))
  })
  ws.on('message', (d) => { let m; try { m = JSON.parse(d) } catch { return } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId)
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  const shot = async (name) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId); writeFileSync(`/tmp/stages-${name}.png`, Buffer.from(data, 'base64')); console.log('  shot → /tmp/stages-' + name + '.png') }

  await send('Page.navigate', { url: pageUrl }, sessionId)
  await delay(7000)

  // The renderer's own stage grid (real viewport) — compute the same stageStride the app uses, so our stage
  // assertions match exactly. SIDEBAR=52, RIGHTPAD=24, STAGE_GAP=1200 (stages-core.mjs).
  const stride = await evalJs(`const w=Math.max(320, window.innerWidth-52-24); return w+1200`)
  // Map: surfaceId -> stage index (round((left + width/2)/stride)). data-sid carries the world x in style.left.
  const stageMap = async () => evalJs(`
    const out={}; for (const el of document.querySelectorAll('[data-sid]')) {
      const sid=el.getAttribute('data-sid'); const left=parseFloat(el.style.left||'0'); const w=el.offsetWidth||parseFloat(el.style.width||'0');
      out[sid]=Math.round((left + w/2)/${stride});
    } return out;`)

  console.log(`stride=${stride}`)
  console.log('\n[1] self-heal: existing agent chats hydrate into their own stages')
  // Poll until the primary chat has actually rendered before snapshotting — a single snapshot races the
  // first paint (the merged sandwich compositor makes the canvas slower to settle on load), which showed
  // up as an intermittent `chat: undefined`. Retry stageMap() until 'chat' lands in stage 0, or ~12s.
  let m1 = {}
  for (let i = 0; i < 10; i++) {
    m1 = await stageMap()
    if (m1['chat'] === 0) break
    await delay(1200)
  }
  console.log('  stage map: ' + JSON.stringify(m1))
  check(m1['chat'] === 0, `primary chat in stage 0 (got ${m1['chat']})`)
  for (const sid of Object.keys(m1)) {
    const mm = /^chat-(\d+)$/.exec(sid)
    if (mm) check(m1[sid] === Number(mm[1]), `${sid} in stage ${mm[1]} (got ${m1[sid]})`)
  }

  console.log('\n[2] spawn a NEW agent via relay → its chat lands in its own stage')
  const spawned = await relay('spawn_agent', { title: 'Stage Test Agent' })
  const newId = spawned && spawned.agent && String(spawned.agent.id)
  check(!!newId, `spawn_agent returned an id (${newId})`)
  await delay(4000)
  const m2 = await stageMap()
  const newChatSid = `chat-${newId}`
  check(m2[newChatSid] === Number(newId), `${newChatSid} chat widget in stage ${newId} (got ${m2[newChatSid]})`)

  console.log('\n[3] that agent opens a surface + a terminal → both land in ITS stage, not the user\'s')
  let surfId = null
  for (let i = 0; i < 3 && !surfId; i++) {
    const created = await relay('create_surface', { kind: 'srcdoc', html: '<h1>agent work window</h1>', agent: newId })
    surfId = created && created.id
    if (!surfId) await delay(1500) // transient relay hiccup — retry
  }
  check(!!surfId, `create_surface {agent:${newId}} returned an id (${surfId})`)
  await relay('open_terminal', { command: 'bash', title: `stage${newId}-shell`, agent: newId })
  // POLL until the canvas settles — a single fixed delay flaked (the new surface/terminal hadn't registered
  // its position yet, reading stage `undefined`). Retry up to ~12s for all three conditions to hold.
  // The terminal surface id is dynamic; find any terminal-bearing surface and report which stage it's in.
  const termStagesExpr = `
    const out=[]; for (const el of document.querySelectorAll('[data-sid]')) {
      if (el.querySelector('.window-tabs') || (el.textContent||'').includes('Terminal')) {
        const left=parseFloat(el.style.left||'0'); const w=el.offsetWidth||0; out.push(Math.round((left+w/2)/${stride}));
      }
    } return out;`
  let m3 = {}, surfStage, termStages = []
  for (let i = 0; i < 10; i++) {
    await delay(1200)
    m3 = await stageMap()
    surfStage = surfId ? m3[surfId] : undefined
    termStages = await evalJs(termStagesExpr)
    if (surfStage === Number(newId) && termStages.includes(Number(newId)) && m3['chat'] === 0) break
  }
  console.log('  stage map after work: ' + JSON.stringify(m3))
  check(surfId && surfStage === Number(newId), `agent-created surface in stage ${newId} (got ${surfStage})`)
  console.log('  terminal-window stages: ' + JSON.stringify(termStages))
  check(termStages.includes(Number(newId)), `a terminal window is in stage ${newId} (got ${JSON.stringify(termStages)})`)
  check(m3['chat'] === 0, `the user's primary chat is STILL in stage 0 (undisturbed) (got ${m3['chat']})`)

  await shot('after')

  // cleanup: close the agent this run spawned (close_agent deletes its chat + files + stage) AND remove the
  // terminal it opened into that stage, so Home is left exactly as found (only the primary agent).
  console.log('\n[cleanup] closing the spawned agent + removing its terminal')
  if (newId) { try { await relay('close_agent', { id: newId }) } catch { /* ignore */ } }
  try { await evalJs(`const ts=(await window.agentOS.terminalList()).filter(s=>s.kind==='terminal'); for(const t of ts){try{window.agentOS.terminalRemove(t.id)}catch{}} return ts.length`) } catch { /* ignore */ }
  await delay(2000) // terminalRemove is a fire-and-forget shim fetch — let it land before we close the socket + exit

  console.log(fails.length ? `\nFAIL ✗ ${fails.length}: ${fails.join(' | ')}` : '\nPASS ✓ stage-per-agent isolation verified')
  ws.close()
  cleanup(fails.length ? 2 : 0)
}
main().catch((e) => { console.error('drive failed:', e.message); cleanup(1) })
