// Cross-agent chat ISOLATION (plans/blitzos-agent-chat-isolation.md). The leak: a spawned agent read a
// SIBLING's transcript from the shared workspace root (`cat chat.md`) and absorbed its task. The fix moves
// every transcript into a private per-agent dir and hardens the bootstrap. This locks both so it can't regress.
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendChatMessage, readChatMessages, chatFileName, relocateLegacyChats } from '../../src/main/workspace.mjs'
import { buildBootstrap } from '../../src/main/agent-runtime.mjs'

let pass = 0, fail = 0
const ok = (n, c) => (c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n)))
const dir = mkdtempSync(join(tmpdir(), 'blitz-iso-'))
const rootChatFiles = () => readdirSync(dir).filter((n) => n === 'chat.md' || /^chat-[a-z0-9_-]+\.md$/i.test(n))

console.log('# transcripts are PRIVATE per-agent paths, not sibling root files')
ok("chatFileName('0') is under .blitzos/agents", chatFileName('0').replace(/\\/g, '/') === '.blitzos/agents/0/chat.md')
ok("chatFileName('1') is its own dir", chatFileName('1').replace(/\\/g, '/') === '.blitzos/agents/1/chat.md')
ok('a crafted id cannot traverse out of the agent dir', !chatFileName('../../../etc').includes('..'))
// A MALFORMED id (a relay agent could pass any string on say/steer) must NEVER collide onto agent '0's chat —
// that would be a cross-agent WRITE into the primary. It also must not collide with another peer or traverse.
const zero = chatFileName('0')
ok("malformed '1.5' does NOT funnel into agent 0's chat", chatFileName('1.5') !== zero)
ok("malformed '0 ' (trailing space) does NOT funnel into agent 0's chat", chatFileName('0 ') !== zero)
ok("malformed 'foo/bar' does NOT funnel into 0 and does NOT traverse", chatFileName('foo/bar') !== zero && !chatFileName('foo/bar').includes('..') && !chatFileName('foo/bar').replace('.blitzos','').includes('/bar'))
ok("empty id still maps to the primary '0' (legacy contract)", chatFileName('') === zero && chatFileName(null) === zero)
ok('two distinct malformed ids get distinct buckets (no silent merge)', chatFileName('1.5') !== chatFileName('1,5'))

console.log('\n# two agents write their own transcript — no leak, root stays clean')
appendChatMessage(dir, 'user', 'find Eventbrite producers', '1')
appendChatMessage(dir, 'agent', 'On it — searching.', '1')
appendChatMessage(dir, 'user', 'highlight the testing doc', '0')
appendChatMessage(dir, 'agent', 'Marking the top 3 red.', '0')
ok('the workspace ROOT exposes NO chat file for a sibling to cat', rootChatFiles().length === 0)
ok("agent 1's thread is ONLY agent 1's messages", readChatMessages(dir, 400, '1').every((m) => /Eventbrite|searching/.test(m.text)))
ok("agent 0's thread is ONLY agent 0's messages", readChatMessages(dir, 400, '0').every((m) => /testing doc|top 3/.test(m.text)))
ok('no cross-contamination either way', !JSON.stringify(readChatMessages(dir, 400, '1')).includes('top 3') && !JSON.stringify(readChatMessages(dir, 400, '0')).includes('Eventbrite'))

console.log('\n# relocateLegacyChats migrates OLD root transcripts in, history intact, root cleaned')
const old = mkdtempSync(join(tmpdir(), 'blitz-legacy-'))
writeFileSync(join(old, 'chat.md'), '# Chat\n\n### user · 111\nlegacy primary\n')
writeFileSync(join(old, 'chat-2.md'), '# Chat\n\n### user · 222\nlegacy peer two\n')
relocateLegacyChats(old)
ok('legacy root chat.md is GONE from the root', !existsSync(join(old, 'chat.md')) && !existsSync(join(old, 'chat-2.md')))
ok('primary history moved into .blitzos/agents/0', readChatMessages(old, 400, '0').some((m) => m.text === 'legacy primary'))
ok('peer history moved into .blitzos/agents/2', readChatMessages(old, 400, '2').some((m) => m.text === 'legacy peer two'))
relocateLegacyChats(old) // idempotent — a second run is a no-op, not a crash
ok('relocate is idempotent', readChatMessages(old, 400, '0').some((m) => m.text === 'legacy primary'))

console.log('\n# migration is non-destructive: stray chat-0.md never clobbers chat.md, dest-exists preserves data')
const coll = mkdtempSync(join(tmpdir(), 'blitz-coll-'))
writeFileSync(join(coll, 'chat.md'), '# Chat\n\n### user · 1\nthe real primary\n')
writeFileSync(join(coll, 'chat-0.md'), '# Chat\n\n### user · 2\nstray not-a-real-transcript\n')
relocateLegacyChats(coll)
ok("chat.md (not the stray chat-0.md) becomes the primary's transcript", readChatMessages(coll, 400, '0').some((m) => m.text === 'the real primary'))
ok("the stray chat-0.md did NOT clobber the primary", !JSON.stringify(readChatMessages(coll, 400, '0')).includes('stray not-a-real-transcript'))
// dest already exists + a root chat.md reappears (e.g. a git merge): the root copy must be preserved, not deleted, and removed from the root.
writeFileSync(join(coll, 'chat.md'), '# Chat\n\n### user · 3\nreappeared root copy\n')
relocateLegacyChats(coll)
ok('a reappeared root chat.md is moved OUT of the root (no readable sibling left)', !existsSync(join(coll, 'chat.md')))
ok('the live primary transcript is NOT clobbered by the reappeared root copy', readChatMessages(coll, 400, '0').some((m) => m.text === 'the real primary'))
rmSync(coll, { recursive: true, force: true })

console.log('\n# bootstrap hardening: isolation rule + no "restarted" lure on a fresh spawn')
const fresh = buildBootstrap('http://x', '1', null, 'Home', null, false)
const resumed = buildBootstrap('http://x', '1', null, 'Home', null, true)
ok('fresh spawn omits the "you may have been restarted" recover lure', !/just been restarted/i.test(fresh))
ok('resume DOES catch up on the prior conversation', /just been restarted/i.test(resumed))
ok('every bootstrap forbids reading another agent\'s chat', /never read another agent's chat/i.test(fresh) && /never read another agent's chat/i.test(resumed))
ok('the bootstrap points the agent at its OWN private transcript path', fresh.includes('.blitzos/agents/1/chat.md'))

rmSync(dir, { recursive: true, force: true })
rmSync(old, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
