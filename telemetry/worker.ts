// blitzos-telemetry — worker for the BlitzOS session-replay backend (plans/blitzos-telemetry.md).
// Deployed to the blitz.dev project `blitzos-telemetry` via scripts/telemetry-push.mjs.
//
// Ingest (the app's uploader posts here, multipart 'values' JSON + optional 'file'):
//   POST /ingest/sessions    upsert the session row (by sid)
//   POST /ingest/segments    gzipped JSONL spool segment -> R2 + row + session counter bumps
//   POST /ingest/frames      jpeg screen frame -> R2 + row
// Dashboard (same worker, vanilla single-page UI):
//   GET /dash                the UI (HTML is public; every data call below is key-gated)
//   GET /dash/data           sessions index + totals + recent errors
//   GET /dash/sdata/:sid     one session + its segments + frames
//   GET /seg/:id             raw gzipped JSONL bytes (client inflates via DecompressionStream)
//   GET /frame/:id           jpeg bytes
// All data routes require the INGEST_KEY secret via x-ingest-key header or ?k= query.
// CRUD rules in teenybase.ts are deny-all; this worker elevates to superadmin AFTER the key check
// (the framework-sanctioned service path needs the locked ADMIN_SERVICE_TOKEN, so we gate + elevate
// ourselves — same trust model, our own secret).
import { $Database, teenyHono, OpenApiExtension, PocketUIExtension, Hono } from 'teenybase'
import config from 'virtual:teenybase'

const userApp = new Hono()

const SID_RE = /^[0-9A-Za-z-]{1,64}$/
const ID_RE = /^[0-9A-Za-z-]{1,64}$/
const INSTALL_RE = /^[0-9A-Za-z-]{1,96}$/
const SAFE_TOKEN_RE = /^[0-9A-Za-z_.:/-]{1,96}$/
const ACTIVITY_EVENT_NAMES = new Set([
  'app.started',
  'app.focused',
  'app.quit',
  'island.opened',
  'island.closed',
  'island.view_changed',
  'settings.opened',
  'onboarding.step_viewed',
  'onboarding.completed',
  'agent.spawned',
  'agent.selected',
  'agent.status_changed',
  'agent.archived',
  'agent.restored',
  'agent.deleted',
  'agent.renamed',
  'chat.message_sent',
  'choice.shown',
  'choice.answered',
  'app_card.opened',
  'app_card.closed',
  'connector.picker_opened',
  'connector.connected',
  'connector.disconnected',
  'tool.called'
])
const ACTIVITY_PROPS = new Set([
  'agentIdHash',
  'status',
  'previousStatus',
  'view',
  'previousView',
  'step',
  'source',
  'connectorKind',
  'tool',
  'ok',
  'success',
  'enabled',
  'hasAttachments',
  'count',
  'total',
  'attachmentCount',
  'messageLengthBucket',
  'durationBucket',
  'msBucket',
  'statusCode'
])
const LENGTH_BUCKETS = new Set(['0', '1-80', '81-280', '281-1000', '1001+'])
const MS_BUCKETS = new Set(['<100ms', '100-500ms', '500ms-2s', '2s-10s', '10s+'])

async function gate(c: any): Promise<any | null> {
  const db = c.get('$db')
  const k = c.req.header('x-ingest-key') || c.req.query('k') || ''
  const want = await db.secretResolver.resolve('$INGEST_KEY')
  if (!want || !k || k !== want) return null
  db.auth = { uid: 'ingest', role: 'superadmin', superadmin: true }
  return db
}

async function readMultipart(c: any): Promise<{ values: any; file: ArrayBuffer | null }> {
  const form = await c.req.raw.formData()
  let values: any = {}
  try {
    values = JSON.parse(String(form.get('values') || '{}'))
  } catch {
    values = {}
  }
  const f = form.get('file')
  const file = f && typeof (f as any).arrayBuffer === 'function' ? await (f as any).arrayBuffer() : null
  return { values, file }
}

async function readJson(c: any): Promise<any> {
  try {
    return await c.req.json()
  } catch {
    return {}
  }
}

function cleanActivityProps(props: any): Record<string, unknown> {
  const input = props && typeof props === 'object' && !Array.isArray(props) ? props : {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!ACTIVITY_PROPS.has(key)) continue
    if (typeof value === 'boolean') {
      out[key] = value
    } else if (typeof value === 'number') {
      if (Number.isFinite(value)) out[key] = Math.max(0, Math.min(1000, Math.round(value)))
    } else if (typeof value === 'string') {
      const s = value.trim()
      if (key === 'messageLengthBucket') {
        if (LENGTH_BUCKETS.has(s)) out[key] = s
        continue
      }
      if (key === 'durationBucket' || key === 'msBucket') {
        if (MS_BUCKETS.has(s)) out[key] = s
        continue
      }
      if (s && SAFE_TOKEN_RE.test(s)) out[key] = s
    }
  }
  return out
}

userApp.get('/ping', (c) => c.json({ ok: true, t: Date.now() }))

// ---- ingest ----

userApp.post('/ingest/sessions', async (c) => {
  const db = await gate(c)
  if (!db) return c.json({ error: 'forbidden' }, 403)
  const { values: v } = await readMultipart(c)
  const sid = String(v.sid || '')
  if (!SID_RE.test(sid)) return c.json({ error: 'bad sid' }, 400)
  const row = {
    sid,
    device: String(v.device || ''),
    version: String(v.version || ''),
    branch: String(v.branch || ''),
    run: Number(v.run) || 0,
    platform: String(v.platform || ''),
    meta: JSON.stringify(v.meta || {})
  }
  const existing = await db.table('sessions').select({ where: `sid == "${sid}"`, limit: 1 })
  if (Array.isArray(existing) && existing.length) {
    await db
      .rawSQL({
        q: 'UPDATE sessions SET device=?, version=?, branch=?, run=?, platform=?, meta=? WHERE sid=?',
        v: [row.device, row.version, row.branch, row.run, row.platform, row.meta, sid]
      })
      .run()
    return c.json({ ok: true, sid, updated: true })
  }
  await db.table('sessions').insert({ values: { id: crypto.randomUUID(), ...row } })
  return c.json({ ok: true, sid, created: true })
})

userApp.post('/ingest/segments', async (c) => {
  const db = await gate(c)
  if (!db) return c.json({ error: 'forbidden' }, 403)
  const { values: v, file } = await readMultipart(c)
  const sid = String(v.sid || '')
  if (!SID_RE.test(sid)) return c.json({ error: 'bad sid' }, 400)
  if (!file || !file.byteLength) return c.json({ error: 'no file' }, 400)
  const id = crypto.randomUUID()
  const key = `telemetry/${sid}/seg-${String(Number(v.seq) || 0).padStart(6, '0')}-${id.slice(0, 8)}.jsonl.gz`
  await (db as any).putFileObject(key, file)
  const counts = v.counts && typeof v.counts === 'object' ? v.counts : {}
  const errs = Array.isArray(v.errs) ? v.errs.slice(0, 10) : []
  await db.table('segments').insert({
    values: {
      id,
      sid,
      seq: Number(v.seq) || 0,
      t0: Number(v.t0) || 0,
      t1: Number(v.t1) || 0,
      lines: Number(v.lines) || 0,
      errn: Number(counts.err) || errs.length || 0,
      counts: JSON.stringify(counts),
      errs: JSON.stringify(errs),
      key
    }
  })
  // single sequential uploader per device, so a read-modify-write would also be fine — but
  // SQL-side arithmetic keeps the counters correct even if two app instances share a sid.
  await db
    .rawSQL({
      q:
        'UPDATE sessions SET events=events+?, errors=errors+?, tools=tools+?, segs=segs+1, ' +
        't0=CASE WHEN t0=0 OR t0>? THEN ? ELSE t0 END, t1=CASE WHEN t1<? THEN ? ELSE t1 END WHERE sid=?',
      v: [Number(v.lines) || 0, Number(counts.err) || 0, Number(counts.tool) || 0, Number(v.t0) || 0, Number(v.t0) || 0, Number(v.t1) || 0, Number(v.t1) || 0, sid]
    })
    .run()
  return c.json({ ok: true, id, key })
})

userApp.post('/ingest/frames', async (c) => {
  const db = await gate(c)
  if (!db) return c.json({ error: 'forbidden' }, 403)
  const { values: v, file } = await readMultipart(c)
  const sid = String(v.sid || '')
  if (!SID_RE.test(sid)) return c.json({ error: 'bad sid' }, 400)
  if (!file || !file.byteLength) return c.json({ error: 'no file' }, 400)
  const id = crypto.randomUUID()
  const t = Number(v.t) || Date.now()
  const key = `telemetry/${sid}/frame-${t}-${id.slice(0, 8)}.jpg`
  await (db as any).putFileObject(key, file)
  await db.table('frames').insert({ values: { id, sid, t, key } })
  await db.rawSQL({ q: 'UPDATE sessions SET frames=frames+1 WHERE sid=?', v: [sid] }).run()
  return c.json({ ok: true, id, key })
})

userApp.post('/ingest/activity', async (c) => {
  const db = await gate(c)
  if (!db) return c.json({ error: 'forbidden' }, 403)
  const v = await readJson(c)
  const sid = String(v.sid || '')
  if (!SID_RE.test(sid)) return c.json({ error: 'bad sid' }, 400)
  const install = String(v.install || '')
  if (install && !INSTALL_RE.test(install)) return c.json({ error: 'bad install' }, 400)
  const rawEvents = Array.isArray(v.events) ? v.events.slice(0, 500) : []
  const events = rawEvents
    .map((ev: any) => ({
      t: Number(ev?.t) || Date.now(),
      name: String(ev?.name || ''),
      props: cleanActivityProps(ev?.props)
    }))
    .filter((ev: any) => ACTIVITY_EVENT_NAMES.has(ev.name))
  if (!events.length) return c.json({ ok: true, sid, events: 0 })

  const t0 = Number(v.t0) || events[0].t || Date.now()
  const t1 = Number(v.t1) || events[events.length - 1].t || t0
  const session = {
    sid,
    install,
    version: String(v.version || '').slice(0, 64),
    branch: String(v.branch || '').slice(0, 64),
    run: Number(v.run) || 0,
    platform: String(v.platform || '').slice(0, 32),
    events: events.length,
    t0,
    t1
  }
  const existing = await db.table('activity_sessions').select({ where: `sid == "${sid}"`, limit: 1 })
  if (Array.isArray(existing) && existing.length) {
    await db
      .rawSQL({
        q:
          'UPDATE activity_sessions SET install=?, version=?, branch=?, run=?, platform=?, events=events+?, ' +
          't0=CASE WHEN t0=0 OR t0>? THEN ? ELSE t0 END, t1=CASE WHEN t1<? THEN ? ELSE t1 END WHERE sid=?',
        v: [session.install, session.version, session.branch, session.run, session.platform, session.events, t0, t0, t1, t1, sid]
      })
      .run()
  } else {
    await db.table('activity_sessions').insert({ values: { id: crypto.randomUUID(), ...session } })
  }
  for (const ev of events) {
    await db.table('activity_events').insert({
      values: {
        id: crypto.randomUUID(),
        sid,
        t: ev.t,
        name: ev.name,
        props: JSON.stringify(ev.props)
      }
    })
  }
  return c.json({ ok: true, sid, events: events.length })
})

// ---- dashboard data ----

userApp.get('/dash/data', async (c) => {
  const db = await gate(c)
  if (!db) return c.json({ error: 'forbidden' }, 403)
  const sessions = await db.table('sessions').select({ order: '-created', limit: 500 })
  const recent = await db.table('segments').select({ where: 'errn > 0', order: '-created', limit: 20 })
  return c.json({ sessions: sessions || [], recentErrSegs: recent || [] })
})

userApp.get('/dash/sdata/:sid', async (c) => {
  const db = await gate(c)
  if (!db) return c.json({ error: 'forbidden' }, 403)
  const sid = c.req.param('sid')
  if (!SID_RE.test(sid)) return c.json({ error: 'bad sid' }, 400)
  const ses = await db.table('sessions').select({ where: `sid == "${sid}"`, limit: 1 })
  const segs = await db.table('segments').select({ where: `sid == "${sid}"`, order: 'seq', limit: 2000 })
  const frames = await db.table('frames').select({ where: `sid == "${sid}"`, order: 't', limit: 5000 })
  return c.json({ session: ses?.[0] || null, segments: segs || [], frames: frames || [] })
})

userApp.get('/dash/activity/data', async (c) => {
  const db = await gate(c)
  if (!db) return c.json({ error: 'forbidden' }, 403)
  const sessions = await db.table('activity_sessions').select({ order: '-updated', limit: 200 })
  const events = await db.table('activity_events').select({ order: '-created', limit: 500 })
  const counts: Record<string, number> = {}
  for (const ev of events || []) counts[String(ev.name || '')] = (counts[String(ev.name || '')] || 0) + 1
  return c.json({ sessions: sessions || [], events: events || [], counts })
})

async function serveObject(c: any, table: string, contentType: string): Promise<Response> {
  const db = await gate(c)
  if (!db) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  if (!ID_RE.test(id)) return c.json({ error: 'bad id' }, 400)
  const rec = await db.table(table).select({ where: `id == "${id}"`, limit: 1 })
  const key = rec?.[0]?.key
  if (!key) return c.json({ error: 'not found' }, 404)
  const obj = await db.getFileObject(String(key))
  if (!obj || !(obj as any).body) return c.json({ error: 'object missing' }, 404)
  return new Response((obj as any).body, {
    headers: { 'content-type': contentType, 'cache-control': 'private, max-age=31536000' }
  })
}

userApp.get('/seg/:id', (c) => serveObject(c, 'segments', 'application/gzip'))
userApp.get('/frame/:id', (c) => serveObject(c, 'frames', 'image/jpeg'))

// ---- dashboard UI (public shell; all data calls above are key-gated) ----

const DASH_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BlitzOS Telemetry</title>
<style>
:root{--bg:#0b0d10;--panel:#14181d;--panel2:#1a2027;--line:#252c35;--tx:#dde4ec;--dim:#8a96a3;--acc:#5aa9ff;--err:#ff6b6b;--ok:#5ad18a;--warn:#ffc35a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.45 ui-sans-serif,system-ui,-apple-system}
a{color:var(--acc);text-decoration:none}code{font-family:ui-monospace,Menlo,monospace}
header{display:flex;align-items:center;gap:18px;padding:10px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
header b{font-size:15px}header nav a{margin-right:12px;color:var(--dim)}header nav a.on{color:var(--tx)}
#app{padding:18px;max-width:1280px;margin:0 auto}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:120px}
.card .v{font-size:22px;font-weight:700}.card .l{color:var(--dim);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);font-size:13px}
th{color:var(--dim);font-weight:600;background:var(--panel2)}tr:hover td{background:var(--panel2);cursor:pointer}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;background:var(--panel2);border:1px solid var(--line)}
.pill.err{color:var(--err);border-color:var(--err)}
.keybox{margin:80px auto;max-width:420px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px;text-align:center}
.keybox input{width:100%;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--tx);margin:12px 0}
button{background:var(--acc);color:#04121f;border:0;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer}
button.ghost{background:var(--panel2);color:var(--tx);border:1px solid var(--line)}
.replay{display:grid;grid-template-columns:minmax(420px,56%) 1fr;gap:16px}
.film{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
.film img{width:100%;border-radius:6px;background:#000;min-height:240px}
.film .bar{display:flex;align-items:center;gap:10px;margin-top:10px}
.film input[type=range]{flex:1}
.evts{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;max-height:78vh;overflow:auto}
.evt{padding:4px 8px;border-radius:6px;margin-bottom:2px;font-size:12px;font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;border-left:3px solid var(--line)}
.evt:hover{background:var(--panel2);cursor:pointer}
.evt.act{border-left-color:var(--acc)}.evt.tool{border-left-color:var(--ok)}.evt.err{border-left-color:var(--err)}
.evt.moment{border-left-color:var(--warn)}.evt.state{border-left-color:#9d7bff}.evt.cur{background:var(--panel2);outline:1px solid var(--acc)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.chip{padding:3px 10px;border-radius:99px;border:1px solid var(--line);background:var(--panel2);color:var(--dim);cursor:pointer;font-size:12px}
.chip.on{color:var(--tx);border-color:var(--acc)}
.muted{color:var(--dim)}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.barrow{display:flex;align-items:center;gap:8px;margin:4px 0}.barrow .b{height:14px;background:var(--acc);border-radius:3px;min-width:2px}
.barrow .b.err{background:var(--err)}
h2{font-size:16px;margin:18px 0 10px}
input.search{padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--tx);min-width:220px}
</style></head><body>
<header><b>⚡ BlitzOS Telemetry</b><nav><a href="#/" id="nav-s">Sessions</a><a href="#/analytics" id="nav-a">Analytics</a></nav>
<span class="muted" id="hdr-note" style="margin-left:auto"></span></header>
<div id="app"></div>
<script>
const $=s=>document.querySelector(s)
const qk=new URLSearchParams(location.search).get('k')
if(qk){localStorage.setItem('tk',qk);history.replaceState(null,'',location.pathname+location.hash)}
let K=localStorage.getItem('tk')||''
const api=async p=>{const r=await fetch(p+(p.includes('?')?'&':'?')+'k='+encodeURIComponent(K));if(r.status===403){askKey();throw new Error('forbidden')}if(!r.ok)throw new Error(p+' '+r.status);return r.json()}
const fmtT=t=>t?new Date(+t).toLocaleString():'—'
const fmtDur=ms=>{if(!ms||ms<0)return '—';const s=Math.round(ms/1e3);return s<60?s+'s':s<3600?Math.floor(s/60)+'m '+(s%60)+'s':Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m'}
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))
function askKey(){$('#app').innerHTML='<div class="keybox"><b>Access key</b><p class="muted">Paste the ingest key to view telemetry.</p><input id="kin" type="password" placeholder="key"/><button onclick="saveKey()">Open</button></div>'}
function saveKey(){K=$('#kin').value.trim();localStorage.setItem('tk',K);render()}
let DATA=null
async function loadIndex(){DATA=await api('/dash/data');return DATA}
// ---- sessions index ----
async function viewIndex(){
  const d=await loadIndex(),ss=d.sessions
  const tot=(f)=>ss.reduce((a,s)=>a+(+s[f]||0),0)
  const vers={};ss.forEach(s=>{const v=(s.version||'?')+(s.run?(' #'+s.run):'');vers[v]=(vers[v]||0)+1})
  let h='<div class="cards">'
  h+=card(ss.length,'sessions')+card(tot('events'),'events')+card(tot('errors'),'errors',tot('errors')?'err':'')+card(tot('frames'),'frames')+card(Object.keys(vers).length,'builds')
  h+='</div><table><tr><th>session</th><th>started</th><th>duration</th><th>device</th><th>build</th><th>platform</th><th>events</th><th>tools</th><th>errors</th><th>frames</th></tr>'
  for(const s of ss){
    h+='<tr onclick="location.hash=\\'#/s/'+s.sid+'\\'"><td><code>'+esc(s.sid)+'</code></td><td>'+fmtT(s.t0)+'</td><td>'+fmtDur(s.t1-s.t0)+'</td><td><code>'+esc(s.device||'—')+'</code></td><td>'+esc((s.version||'?')+(s.branch?' '+s.branch:'')+(s.run?' #'+s.run:''))+'</td><td>'+esc(s.platform||'')+'</td><td>'+(s.events||0)+'</td><td>'+(s.tools||0)+'</td><td>'+(+s.errors?'<span class="pill err">'+s.errors+'</span>':'0')+'</td><td>'+(s.frames||0)+'</td></tr>'
  }
  h+='</table>'
  if(!ss.length)h+='<p class="muted" style="margin-top:14px">No sessions yet — boot BlitzOS with ~/.blitzos/telemetry.json configured and data appears here within ~40s.</p>'
  $('#app').innerHTML=h
}
const card=(v,l,cls)=>'<div class="card"><div class="v'+(cls?' '+cls:'')+'" '+(cls==='err'?'style="color:var(--err)"':'')+'>'+v+'</div><div class="l">'+l+'</div></div>'
// ---- analytics ----
async function viewAnalytics(){
  const d=DATA||await loadIndex(),ss=d.sessions
  const byV={},byD={}
  ss.forEach(s=>{const v=(s.version||'?')+(s.run?(' #'+s.run):'');byV[v]=byV[v]||{n:0,err:0,ev:0,dur:0};byV[v].n++;byV[v].err+=+s.errors||0;byV[v].ev+=+s.events||0;byV[v].dur+=Math.max(0,(+s.t1||0)-(+s.t0||0));
    const day=s.t0?new Date(+s.t0).toISOString().slice(0,10):'?';byD[day]=(byD[day]||0)+1})
  let h='<h2>Errors & volume by build</h2>'
  const mx=Math.max(1,...Object.values(byV).map(x=>x.ev))
  for(const[v,x]of Object.entries(byV)){
    h+='<div class="barrow"><span style="width:170px" class="muted">'+esc(v)+'</span><div class="b" style="width:'+Math.round(280*x.ev/mx)+'px"></div><span>'+x.ev+' ev</span><div class="b err" style="width:'+Math.min(280,x.err*6)+'px"></div><span style="color:var(--err)">'+x.err+' err</span><span class="muted">'+x.n+' sess, avg '+fmtDur(x.dur/x.n)+'</span></div>'
  }
  h+='<h2>Sessions per day</h2>'
  const md=Math.max(1,...Object.values(byD))
  for(const[day,n]of Object.entries(byD).sort()){h+='<div class="barrow"><span style="width:110px" class="muted">'+day+'</span><div class="b" style="width:'+Math.round(280*n/md)+'px"></div><span>'+n+'</span></div>'}
  h+='<h2>Recent errors (across sessions)</h2>'
  const errs=[];(d.recentErrSegs||[]).forEach(sg=>{let a=[];try{a=JSON.parse(sg.errs||'[]')}catch{}a.forEach(e=>errs.push({sid:sg.sid,t:e.t,m:e.m}))})
  if(!errs.length)h+='<p class="muted">none captured yet</p>'
  errs.slice(0,30).forEach(e=>{h+='<div class="evt err" onclick="location.hash=\\'#/s/'+e.sid+'\\'">'+fmtT(e.t)+' <span class="muted">'+esc(e.sid)+'</span>\\n'+esc((e.m||'').slice(0,300))+'</div>'})
  $('#app').innerHTML=h
}
// ---- session replay ----
let R=null
async function viewSession(sid){
  $('#app').innerHTML='<p class="muted">loading session…</p>'
  const d=await api('/dash/sdata/'+sid)
  if(!d.session){$('#app').innerHTML='<p>session not found</p>';return}
  R={s:d.session,frames:d.frames,segs:d.segments,lines:[],filters:{act:1,tool:1,moment:1,err:1,state:0},fi:0,playing:null,speed:4,q:''}
  let h='<div class="row" style="margin-bottom:12px"><a href="#/">← sessions</a><b><code>'+esc(sid)+'</code></b><span class="muted">'+fmtT(R.s.t0)+' · '+fmtDur(R.s.t1-R.s.t0)+' · '+esc(R.s.version||'')+(R.s.run?' #'+R.s.run:'')+' · '+esc(R.s.device||'')+'</span></div>'
  h+='<div class="replay"><div class="film"><img id="fimg"/><div class="bar"><button id="pp" onclick="togglePlay()">▶</button><input type="range" id="scrub" min="0" max="'+Math.max(0,R.frames.length-1)+'" value="0"/><span id="ftime" class="muted" style="min-width:150px"></span><button class="ghost" onclick="cycleSpeed()" id="spd">4×</button></div>'
  h+='<div class="muted" style="margin-top:6px">'+R.frames.length+' frames · '+R.segs.length+' segments · '+(R.s.events||0)+' events</div></div>'
  h+='<div class="evts"><div class="chips" id="chips"></div><div class="row" style="margin-bottom:8px"><input class="search" id="evq" placeholder="search events…" oninput="R.q=this.value;drawEvents()"/><span class="muted" id="segprog"></span></div><div id="evlist"><p class="muted">loading events…</p></div></div></div>'
  $('#app').innerHTML=h
  drawChips();showFrame(0)
  $('#scrub').oninput=e=>{showFrame(+e.target.value)}
  loadSegments()
}
function drawChips(){
  const c=$('#chips');if(!c)return
  c.innerHTML=Object.keys(R.filters).map(t=>'<span class="chip '+(R.filters[t]?'on':'')+'" onclick="R.filters[\\''+t+'\\']^=1;drawChips();drawEvents()">'+t+'</span>').join('')
}
async function loadSegments(){
  let done=0
  for(const sg of R.segs){
    try{
      const r=await fetch('/seg/'+sg.id+'?k='+encodeURIComponent(K))
      const buf=new Uint8Array(await r.arrayBuffer())
      let txt
      if(buf[0]===0x1f&&buf[1]===0x8b){const ds=new DecompressionStream('gzip');txt=await new Response(new Blob([buf]).stream().pipeThrough(ds)).text()}
      else txt=new TextDecoder().decode(buf)
      for(const l of txt.split('\\n')){if(!l)continue;try{R.lines.push(JSON.parse(l))}catch{}}
    }catch(e){console.warn('seg load failed',sg.id,e)}
    done++;const sp=$('#segprog');if(sp)sp.textContent=done+'/'+R.segs.length+' segments'
    if(done%3===0||done===R.segs.length){R.lines.sort((a,b)=>a.t-b.t);drawEvents()}
  }
  R.lines.sort((a,b)=>a.t-b.t);drawEvents()
}
function evSummary(e){
  const d=e.d||{}
  if(e.ty==='tool')return (d.path||'?')+' '+(d.status||'')+' '+(d.ms!=null?d.ms+'ms':'')
  if(e.ty==='err')return (d.via?'['+d.via+'] ':'')+(d.m||'').slice(0,400)
  if(e.ty==='moment')return (d.trigger||'')+' '+(d.url||d.title||'')
  if(e.ty==='act')return (d.type||d.action||JSON.stringify(d).slice(0,200))
  return JSON.stringify(d).slice(0,200)
}
function drawEvents(){
  const el=$('#evlist');if(!el)return
  const q=(R.q||'').toLowerCase()
  const vis=R.lines.filter(e=>R.filters[e.ty]!==0&&(R.filters[e.ty]||R.filters[e.ty]===undefined)&&(!q||JSON.stringify(e).toLowerCase().includes(q)))
  const cur=R.frames[R.fi]?+R.frames[R.fi].t:0
  let h='',shown=0
  for(const e of vis){
    if(shown>2500){h+='<p class="muted">…'+(vis.length-shown)+' more (refine filters)</p>';break}
    const near=cur&&Math.abs(e.t-cur)<2500?' cur':''
    h+='<div class="evt '+esc(e.ty)+near+'" onclick="seekTo('+e.t+')"><span class="muted">'+new Date(e.t).toLocaleTimeString()+'</span> <b>'+esc(e.ty)+'</b> '+esc(evSummary(e))+'</div>'
    shown++
  }
  el.innerHTML=h||'<p class="muted">no events match</p>'
}
function showFrame(i){
  if(!R.frames.length){$('#ftime').textContent='no frames';return}
  R.fi=Math.max(0,Math.min(R.frames.length-1,i))
  const f=R.frames[R.fi]
  $('#fimg').src='/frame/'+f.id+'?k='+encodeURIComponent(K)
  $('#scrub').value=R.fi
  $('#ftime').textContent=new Date(+f.t).toLocaleTimeString()+' ('+(R.fi+1)+'/'+R.frames.length+')'
  drawEvents()
}
function seekTo(t){let best=0,bd=1e15;R.frames.forEach((f,i)=>{const d=Math.abs(f.t-t);if(d<bd){bd=d;best=i}});showFrame(best)}
function togglePlay(){
  if(R.playing){clearTimeout(R.playing);R.playing=null;$('#pp').textContent='▶';return}
  $('#pp').textContent='⏸'
  const step=()=>{
    if(R.fi>=R.frames.length-1){$('#pp').textContent='▶';R.playing=null;return}
    const dt=Math.min(8000,Math.max(120,(+R.frames[R.fi+1].t-+R.frames[R.fi].t)))/R.speed
    R.playing=setTimeout(()=>{showFrame(R.fi+1);step()},dt)
  }
  step()
}
function cycleSpeed(){R.speed=R.speed===1?2:R.speed===2?4:R.speed===4?10:1;$('#spd').textContent=R.speed+'×'}
// ---- router ----
async function render(){
  if(!K){askKey();return}
  const h=location.hash||'#/'
  $('#nav-s').className=h.startsWith('#/s')||h==='#/'?'on':'';$('#nav-a').className=h==='#/analytics'?'on':''
  try{
    if(h==='#/')await viewIndex()
    else if(h==='#/analytics')await viewAnalytics()
    else if(h.startsWith('#/s/'))await viewSession(h.slice(4))
    else await viewIndex()
  }catch(e){if(String(e).includes('forbidden'))return;$('#app').innerHTML='<p style="color:var(--err)">'+esc(String(e))+'</p>'}
}
window.addEventListener('hashchange',render)
document.addEventListener('keydown',e=>{if(!R||!location.hash.startsWith('#/s/'))return;if(e.key==='ArrowRight')showFrame(R.fi+1);if(e.key==='ArrowLeft')showFrame(R.fi-1);if(e.key===' '&&document.activeElement.tagName!=='INPUT'){e.preventDefault();togglePlay()}})
render()
</script></body></html>`

userApp.get('/', (c) => c.redirect('/dash'))
userApp.get('/dash', (c) => c.html(DASH_HTML))

const app = teenyHono(async (c: any) => {
  const db = new $Database(c, config, c.env.TEENY_PRIMARY_DB, c.env.TEENY_PRIMARY_R2)
  await db.registerExtension(new OpenApiExtension(db, true))
  await db.registerExtension(new PocketUIExtension(db))
  return db
})

app.route('/', userApp)

export default app
