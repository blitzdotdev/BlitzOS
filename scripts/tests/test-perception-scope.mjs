#!/usr/bin/env node
// v2 cross-workspace bleed fix: moments are stamped with the workspace active at emission, and a
// workspace-pinned waiter only sees its own workspace's moments. Run: node scripts/test-perception-scope.mjs
import { setWorkspaceProvider, emitUserMessage, waitForEvents, latestSeq } from '../../src/main/perception-core.mjs'
import { buildBootstrap } from '../../src/main/agent-runtime.mjs'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

let active = 'A'
setWorkspaceProvider(() => active)

const since0 = latestSeq()
emitUserMessage('hello from A', '0')
active = 'B'
emitUserMessage('hello from B', '0')

const all = await waitForEvents(since0, 0, '0')
ok(all.length === 2 && all[0].workspace === 'A' && all[1].workspace === 'B', 'moments are stamped with the workspace active at emission')

const onlyA = await waitForEvents(since0, 0, '0', 'A')
ok(onlyA.length === 1 && onlyA[0].workspace === 'A', "a waiter pinned to A sees ONLY A's moments")

const onlyB = await waitForEvents(since0, 0, '0', 'B')
ok(onlyB.length === 1 && onlyB[0].workspace === 'B', "a waiter pinned to B sees ONLY B's moments")

const unscoped = await waitForEvents(since0, 0, '0', null)
ok(unscoped.length === 2, 'an unscoped waiter (legacy/trusted local) still sees everything')

// a LONG-POLL waiter pinned to A must not be woken by B's moment, but must wake on A's
const since1 = latestSeq()
const pinnedA = waitForEvents(since1, 1500, '0', 'A')
active = 'B'
emitUserMessage('B noise', '0')
active = 'A'
emitUserMessage('A signal', '0')
const got = await pinnedA
ok(got.length === 1 && /A signal/.test(JSON.stringify(got[0].user || [])), 'a pinned long-poll waiter wakes only on its own workspace')

// the bootstrap pins agents: every /events and /say body carries the workspace
const boot = buildBootstrap('http://x', '0', null, 'CaseFile')
ok((boot.match(/"workspace":"CaseFile"/g) || []).length >= 2, 'bootstrap pins /events + /say to the agent workspace')
const boot1 = buildBootstrap('http://x', '1', null, 'CaseFile')
ok(boot1.includes('"agent":"1","workspace":"CaseFile"'), 'non-primary bootstrap carries agent AND workspace')

if (failed) {
  console.error(`\n✗ ${failed} failed`)
  process.exit(1)
}
console.log('\n✓ perception workspace-scoping test passed')
