// #51 — prove the write-approval queue: concurrent pending writes are tracked independently (no
// single-slot overwrite — the review's MAJOR), each resolves exactly once, expiry denies, and the
// expiry timer is cleared on settle (the nit). Pure Node with injected timers + clock.
import { createApprovalQueue } from '../../src/main/approval-queue.mjs'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}

// fake ledger: approve(id) → a deterministic token; broadcast + timers recorded for assertions.
const ledger = { approve: (id) => `tok-${id}` }
const broadcasts = []
const timers = new Map() // handle -> fn (fire manually)
let cleared = 0
let hid = 0
const queue = createApprovalQueue({
  ledger,
  broadcast: (m) => broadcasts.push(m),
  now: () => 1000,
  setTimer: (fn) => {
    const h = ++hid
    timers.set(h, fn)
    return h
  },
  clearTimer: (h) => {
    if (timers.delete(h)) cleared++
  }
})
const req = (id) => ({ id, provider: 'github', method: 'POST', path: '/repos/o/r/issues', risk: 'write', summary: `write ${id}`, expiresAt: 1000 + 60000 })

console.log('approval queue — concurrent writes resolve independently:')
let aResolved, bResolved
const pA = queue.request(req('A')).then((t) => (aResolved = t))
const pB = queue.request(req('B')).then((t) => (bResolved = t))
ok('two concurrent requests → two pending + two broadcasts (no overwrite)', queue.pendingCount() === 2 && broadcasts.filter((b) => b.type === 'provider-approval').length === 2, { pending: queue.pendingCount(), bc: broadcasts.length })

queue.approve('A')
await pA
ok('approving A resolves A with its token', aResolved === 'tok-A', aResolved)
ok('B is still pending (not overwritten/affected by A)', queue.pendingCount() === 1 && bResolved === undefined, { pending: queue.pendingCount(), bResolved })
ok("A's expiry timer was cleared on settle (no orphan)", cleared === 1, cleared)

queue.deny('B')
await pB
ok('denying B resolves B with null', bResolved === null, bResolved)
ok('no approvals pending after both settled', queue.pendingCount() === 0)
ok("B's timer also cleared", cleared === 2, cleared)

console.log('\nexpiry + double-settle:')
let cResolved = 'unset'
const pC = queue.request(req('C')).then((t) => (cResolved = t))
// fire C's expiry timer manually → denied
const cTimer = [...timers.values()].pop()
cTimer()
await pC
ok('expiry resolves the pending write to null (denied)', cResolved === null, cResolved)
// approving an already-settled id is a no-op (no throw, no second resolution)
const before = cResolved
queue.approve('C')
queue.deny('C')
ok('approve/deny on an already-settled id is a safe no-op', cResolved === before && queue.pendingCount() === 0)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
