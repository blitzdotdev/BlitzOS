#!/usr/bin/env node
// E2E verification battery for the blitzos-telemetry backend. Run after every push:
//   node scripts/telemetry-verify.mjs            (synthetic session -> ingest -> read back)
// Exits non-zero on any failure. Reads {url} from ~/.blitzos/telemetry.json and the key
// from ~/.blitzos/telemetry-ingest.key (falls back to telemetry.json's key).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { gzipSync, gunzipSync } from 'node:zlib'

const cfg = JSON.parse(readFileSync(join(homedir(), '.blitzos', 'telemetry.json'), 'utf8'))
let key = cfg.key
try {
  key = readFileSync(join(homedir(), '.blitzos', 'telemetry-ingest.key'), 'utf8').trim() || key
} catch {
  /* use cfg.key */
}
const URL_ = cfg.url
let failed = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failed++
}

const post = async (path, values, file, useKey = key) => {
  const form = new FormData()
  form.set('values', JSON.stringify(values))
  if (file) form.set('file', new Blob([file.buf], { type: file.type }), 'f')
  const res = await fetch(`${URL_}/ingest/${path}`, { method: 'POST', headers: { 'x-ingest-key': useKey }, body: form })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}
const postJson = async (path, values, useKey = key) => {
  const res = await fetch(`${URL_}/ingest/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': useKey },
    body: JSON.stringify(values)
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}
const get = async (path) => {
  const res = await fetch(`${URL_}${path}${path.includes('?') ? '&' : '?'}k=${key}`)
  return res
}

const sid = `verify-${Date.now().toString(36)}`
const t0 = Date.now() - 60_000

console.log(`telemetry-verify → ${URL_} (sid ${sid})`)

// 1. ping + auth gate
const ping = await fetch(`${URL_}/ping`)
ok('ping', ping.ok)
const bad = await post('sessions', { sid }, undefined, 'wrong-key')
ok('bad key → 403', bad.status === 403, `got ${bad.status}`)

// 2. session upsert (insert, then update path)
const s1 = await post('sessions', { sid, device: 'verify', version: '0.0.0', branch: 'verify', run: 999, platform: 'darwin', meta: { synthetic: true } })
ok('session insert', s1.status === 200 && s1.json.ok === true, JSON.stringify(s1.json).slice(0, 120))
const s2 = await post('sessions', { sid, device: 'verify', version: '0.0.1', branch: 'verify', run: 999, platform: 'darwin', meta: { synthetic: true } })
ok('session upsert', s2.status === 200 && s2.json.updated === true, JSON.stringify(s2.json).slice(0, 120))

// 3. segment: realistic JSONL, gzipped; counts/errs as the app computes them
const lines = [
  { t: t0 + 1000, ty: 'boot', d: { version: '0.0.1', branch: 'verify' } },
  { t: t0 + 2000, ty: 'act', d: { type: 'create', surface: { id: 'w1', kind: 'note', title: 'hello' } } },
  { t: t0 + 3000, ty: 'tool', d: { path: 'list_state', transport: 'local', ms: 12, status: 'ok' } },
  { t: t0 + 4000, ty: 'moment', d: { trigger: 'idle', url: 'https://example.com' } },
  { t: t0 + 5000, ty: 'err', d: { via: 'console', m: 'synthetic error for verify' } },
  { t: t0 + 6000, ty: 'state', d: { surfaces: 3, mode: 'canvas' } }
]
const jsonl = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
const gz = gzipSync(Buffer.from(jsonl))
const counts = { boot: 1, act: 1, tool: 1, moment: 1, err: 1, state: 1 }
const errs = [{ t: t0 + 5000, m: 'synthetic error for verify' }]
const sg = await post('segments', { sid, seq: 0, t0: t0 + 1000, t1: t0 + 6000, lines: lines.length, counts, errs }, { buf: gz, type: 'application/gzip' })
ok('segment ingest', sg.status === 200 && sg.json.ok === true, JSON.stringify(sg.json).slice(0, 160))

// 4. frame: minimal valid 1x1 JPEG
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64'
)
const fr = await post('frames', { sid, t: t0 + 3500 }, { buf: JPG, type: 'image/jpeg' })
ok('frame ingest', fr.status === 200 && fr.json.ok === true, JSON.stringify(fr.json).slice(0, 160))

// 4b. activity: safe JSON batch; backend should keep only sanitized props.
const activitySid = `act-${sid}`
const actBad = await postJson('activity', { sid: activitySid, events: [] }, 'wrong-key')
ok('activity bad key → 403', actBad.status === 403, `got ${actBad.status}`)
const actBatch = await postJson('activity', {
  sid: activitySid,
  install: 'verify-install',
  version: '0.0.1',
  branch: 'verify',
  run: 999,
  channel: 'production',
  platform: 'darwin',
  t0: t0 + 7000,
  t1: t0 + 9000,
  events: [
    { t: t0 + 7000, name: 'app.started', props: { source: 'main', title: 'do-not-store' } },
    { t: t0 + 8000, name: 'chat.message_sent', props: { agentIdHash: 'abcdef1234567890', messageLengthBucket: '1001+', text: 'private', url: 'https://example.com/private' } },
    { t: t0 + 9000, name: 'tool.called', props: { tool: '/read_window', statusCode: 200, msBucket: '<100ms', args: { secret: true }, result: { text: 'private' } } }
  ]
})
ok('activity batch ingest', actBatch.status === 200 && actBatch.json.ok === true && actBatch.json.events === 3, JSON.stringify(actBatch.json).slice(0, 160))

// 5. dashboard data: counters bumped
const dd = await (await get('/dash/data')).json()
const ses = (dd.sessions || []).find((s) => s.sid === sid)
ok('session in /dash/data', !!ses)
ok('counters bumped', ses && +ses.events === 6 && +ses.errors === 1 && +ses.tools === 1 && +ses.frames === 1 && +ses.segs === 1, ses && `events=${ses.events} errors=${ses.errors} tools=${ses.tools} frames=${ses.frames} segs=${ses.segs}`)
ok('t0/t1 set', ses && +ses.t0 === t0 + 1000 && +ses.t1 === t0 + 6000, ses && `t0=${ses.t0} t1=${ses.t1}`)
ok('recent errors include segment', (dd.recentErrSegs || []).some((g) => g.sid === sid))

const ad = await (await get('/dash/activity/data')).json()
const actSes = (ad.sessions || []).find((s) => s.sid === activitySid)
const actEvents = (ad.events || []).filter((e) => e.sid === activitySid)
ok('activity session in /dash/activity/data', !!actSes)
ok('activity counters aggregate', actSes && +actSes.events === 3, actSes && `events=${actSes.events}`)
ok('activity channel stored', actSes && actSes.channel === 'production', actSes && `channel=${actSes.channel}`)
ok('activity events roundtrip', actEvents.length === 3, `got ${actEvents.length}`)
ok('activity counts aggregate', ad.counts && +ad.counts['chat.message_sent'] >= 1)
ok(
  'activity props are sanitized',
  actEvents.every((e) => {
    let props = {}
    try { props = JSON.parse(e.props || '{}') } catch { props = {} }
    const body = JSON.stringify(props)
    return !/(private|do-not-store|https:\/\/|args|result|title|url|text)/.test(body)
  })
)
ok(
  'activity bucket props survive backend sanitizer',
  actEvents.some((e) => String(e.props || '').includes('"messageLengthBucket":"1001+"')) &&
    actEvents.some((e) => String(e.props || '').includes('"msBucket":"<100ms"'))
)
const activityDash = await fetch(`${URL_}/activity`)
const activityDashTxt = await activityDash.text()
ok('activity dashboard HTML serves', activityDash.ok && activityDashTxt.includes('BlitzOS Activity') && activityDashTxt.includes('/dash/activity/data'))

// 6. session detail + object roundtrips
const sd = await (await get(`/dash/sdata/${sid}`)).json()
ok('sdata session', sd.session?.sid === sid)
ok('sdata segments', sd.segments?.length === 1)
ok('sdata frames', sd.frames?.length === 1)
if (sd.segments?.length) {
  const segRes = await get(`/seg/${sd.segments[0].id}`)
  const segBuf = Buffer.from(await segRes.arrayBuffer())
  let body = segBuf
  if (segBuf[0] === 0x1f && segBuf[1] === 0x8b) body = gunzipSync(segBuf)
  ok('segment roundtrip byte-perfect', body.toString() === jsonl, `${body.length}/${jsonl.length} bytes`)
}
if (sd.frames?.length) {
  const frRes = await get(`/frame/${sd.frames[0].id}`)
  const frBuf = Buffer.from(await frRes.arrayBuffer())
  ok('frame roundtrip byte-perfect', frBuf.equals(JPG), `${frBuf.length}/${JPG.length} bytes`)
  ok('frame content-type', (frRes.headers.get('content-type') || '').includes('image/jpeg'))
}

// 7. dash UI shell serves
const dash = await fetch(`${URL_}/dash`)
const dashTxt = await dash.text()
ok('dash HTML serves', dash.ok && dashTxt.includes('BlitzOS Telemetry'))

console.log(failed ? `\n${failed} FAILURES` : '\nall green')
process.exit(failed ? 1 : 0)
