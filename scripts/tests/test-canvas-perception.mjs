#!/usr/bin/env node
// Canvas-ops perception (the brain sees window movement): coalescing, settle/batch cadence,
// origin tagging, and primary-only visibility. Pure core — no Electron.
//   node scripts/test-canvas-perception.mjs   (~12s: real timers, the sweep runs every 2s)
import { ingestCanvasOps, waitForEvents, latestSeq } from '../src/main/perception-core.mjs'

let failed = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1) structural op flushes after the ~2s settle (+2s sweep granularity)
const since0 = latestSeq()
ingestCanvasOps([{ op: 'open', id: 'w1', title: 'NYT', kind: 'web', origin: 'tool' }])
await sleep(4500)
let events = await waitForEvents(since0, 0)
ok('structural op flushed within ~4.5s', events.length === 1, `got ${events.length}`)
const m1 = events[0]
ok("trigger is 'canvas'", m1?.trigger === 'canvas')
ok('signals.open counted', m1?.signals?.open === 1)
ok('user line readable + origin-tagged', /opened web 'NYT' \[agent tool\]/.test(m1?.user?.[0] || ''), JSON.stringify(m1?.user))
ok('structured ops carried', Array.isArray(m1?.ops) && m1.ops[0]?.id === 'w1')

// 2) repeated moves of one surface coalesce to the LATEST geometry; pure moves do NOT flush early
const since1 = latestSeq()
ingestCanvasOps([{ op: 'move', id: 'w2', title: 'Notepad', x: 100, y: 100, origin: 'human' }])
ingestCanvasOps([{ op: 'move', id: 'w2', title: 'Notepad', x: 200, y: 150, origin: 'human' }])
ingestCanvasOps([{ op: 'move', id: 'w2', title: 'Notepad', x: 400, y: -200, origin: 'human' }])
await sleep(4500)
events = await waitForEvents(since1, 0)
ok('pure moves ride the batch (no early flush)', events.length === 0, `got ${events.length}`)

// 3) a structural op joins the pending batch and flushes it — ONE moment, move deduped to latest
ingestCanvasOps([{ op: 'close', id: 'w3', title: 'old tab', origin: 'human' }])
await sleep(4500)
events = await waitForEvents(since1, 0)
ok('joined flush produced ONE moment', events.length === 1, `got ${events.length}`)
const m2 = events[0]
ok('move deduped to latest coords', m2?.ops?.some((o) => o.id === 'w2' && o.x === 400 && o.y === -200), JSON.stringify(m2?.ops))
ok('human ops not tool-tagged', /moved 'Notepad' to 400,-200$/.test((m2?.user || []).find((u) => u.includes('Notepad')) || ''), JSON.stringify(m2?.user))
ok('close included', m2?.signals?.close === 1)

// 4) visibility: canvas moments reach ONLY the primary watcher
const all0 = await waitForEvents(0, 0, '0')
const all7 = await waitForEvents(0, 0, '7')
ok('primary sees canvas moments', all0.some((m) => m.trigger === 'canvas'))
ok('non-primary session does NOT', !all7.some((m) => m.trigger === 'canvas'))

console.log(failed ? `\n${failed} FAILURES` : '\nall green')
process.exit(failed ? 1 : 0)
