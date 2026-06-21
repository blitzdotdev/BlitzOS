// Proves the per-message attachment snapshot persists on disk (and survives a "restart" = a fresh store instance).
// This is the part of the feature verifiable headlessly (the GUI render is the user's visual confirm).
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeAttachmentStore } from '../src/main/attachment-store.mjs'

let pass = 0
let fail = 0
function ok(name, cond) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name)
  }
}

const ws = mkdtempSync(join(tmpdir(), 'blitz-att-'))
const store = makeAttachmentStore({ getWorkspacePath: () => ws, markWrite: () => {} })

ok('an empty chat lists nothing', Object.keys(store.listAttachments('0').attachments).length === 0)

const groups = [{ key: 'b:chrome', type: 'tab', label: 'Chrome', appIcon: 'AAA', items: [{ connId: 'c1', favicon: 'f', title: 'Gmail' }] }]
ok('record returns ok', store.recordAttachments('0', 2, groups).ok === true)
ok('the file is written under .blitzos/attachments', existsSync(join(ws, '.blitzos', 'attachments', '0.json')))

const got = store.listAttachments('0').attachments
ok('list returns the recorded ordinal', Array.isArray(got['2']) && got['2'][0].label === 'Chrome')
ok('the frozen base64 icon survives the round-trip', got['2'][0].appIcon === 'AAA')

store.recordAttachments('0', 5, [{ key: 'a:Ghostty', type: 'window', label: 'Ghostty', items: [{ connId: 'c2', title: '~/dev' }] }])
const got2 = store.listAttachments('0').attachments
ok('a second record MERGES (both ordinals present, none clobbered)', !!got2['2'] && !!got2['5'])

// RESTART: a brand-new store instance reading the same workspace must see everything (this is the real claim).
const store2 = makeAttachmentStore({ getWorkspacePath: () => ws, markWrite: () => {} })
const after = store2.listAttachments('0').attachments
ok('survives restart (fresh instance): ordinal 2 still there', after['2'] && after['2'][0].label === 'Chrome')
ok('survives restart: ordinal 5 still there', after['5'] && after['5'][0].label === 'Ghostty')

// per-chat isolation
store.recordAttachments('3', 0, [{ key: 'b:chrome', type: 'tab', label: 'Chrome', items: [{ connId: 'x', title: 'T' }] }])
ok("chat '0' is unaffected by chat '3'", !store.listAttachments('0').attachments['0'])
ok("chat '3' keeps its own file", !!store.listAttachments('3').attachments['0'])

// no workspace → graceful (never throws, just empty / an error result)
const none = makeAttachmentStore({ getWorkspacePath: () => null })
ok('no workspace: list is empty', Object.keys(none.listAttachments('0').attachments).length === 0)
ok('no workspace: record errors gracefully', !!none.recordAttachments('0', 0, []).error)

rmSync(ws, { recursive: true, force: true })
console.log('\n' + (fail ? '✗' : '✓') + ' attachment-store: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
