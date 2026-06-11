// Phase 3/4 core: the chat transcript is a STRUCTURED WORKSPACE FILE (chat.md) the OS serializes, and the
// chat UI is a recreatable, customizable workspace file (blitz-chat.html). Proven against the real fns.
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendChatMessage, readChatMessages, ensureSystemRenderer, readSystemRenderer, isSystemFile, systemRoleOf, writeWorkspace, readWorkspace } from '../src/main/workspace.mjs'

let pass = 0
let fail = 0
const ok = (n, c) => (c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n)))
const dir = mkdtempSync(join(tmpdir(), 'blitz-chat-'))

console.log('# chat transcript (chat.md) — the OS owns the serialization, in the folder')
appendChatMessage(dir, 'user', 'open photopea')
appendChatMessage(dir, 'agent', 'Opened Photopea.\nIt may take a moment.')
ok('chat.md created in the workspace folder', existsSync(join(dir, 'chat.md')))
let msgs = readChatMessages(dir)
ok('two messages parsed back', msgs.length === 2)
ok('roles + order correct', msgs[0].role === 'user' && msgs[1].role === 'agent')
ok('user text round-trips', msgs[0].text === 'open photopea')
ok('multi-line agent text round-trips', msgs[1].text === 'Opened Photopea.\nIt may take a moment.')
ok('timestamps captured', msgs[0].ts > 0)
ok('chat.md is human-readable markdown', /^# Chat/.test(readFileSync(join(dir, 'chat.md'), 'utf8')) && readFileSync(join(dir, 'chat.md'), 'utf8').includes('### user'))

console.log('\n# transcript recreated on append after a delete')
unlinkSync(join(dir, 'chat.md'))
appendChatMessage(dir, 'user', 'again')
ok('append recreates chat.md', existsSync(join(dir, 'chat.md')) && readChatMessages(dir).length === 1)

console.log('\n# system renderer (blitz-chat.html) — default / recreate-on-missing / customize')
const r1 = ensureSystemRenderer(dir, 'chat')
ok('blitz-chat.html written from the shipped default', !!r1 && r1.created && existsSync(join(dir, 'blitz-chat.html')))
ok('default ships the hub renderer (blitz-ui cards)', readFileSync(join(dir, 'blitz-chat.html'), 'utf8').includes('blitz-ui'))
const r2 = ensureSystemRenderer(dir, 'chat')
ok('second ensure does NOT overwrite (created:false)', !!r2 && r2.created === false)
writeFileSync(join(dir, 'blitz-chat.html'), '<blitz-titlebar>My Chat</blitz-titlebar>')
ensureSystemRenderer(dir, 'chat')
ok('ensure never clobbers a customization', readSystemRenderer(dir, 'chat').includes('My Chat'))
unlinkSync(join(dir, 'blitz-chat.html'))
ok('a deleted renderer falls back to the shipped default', (readSystemRenderer(dir, 'chat') || '').includes('blitz-ui'))
ensureSystemRenderer(dir, 'chat')
ok('…and is recreated on the next ensure (user requirement)', existsSync(join(dir, 'blitz-chat.html')))

console.log('\n# recognition (so system files do not double-surface as plain tiles)')
ok('isSystemFile(chat.md)', isSystemFile('chat.md'))
ok('isSystemFile(blitz-chat.html)', isSystemFile('blitz-chat.html'))
ok('a user note is NOT a system file', !isSystemFile('my-notes.md') && !isSystemFile('readme.html'))
ok('systemRoleOf(blitz-chat.html) = chat', systemRoleOf('blitz-chat.html') === 'chat')
ok('systemRoleOf(blitz-foo.html) = null (unknown role)', systemRoleOf('blitz-foo.html') === null)

console.log('\n# note → opt-in custom widget (default native; blitz-note.html → srcdoc; still persists as .md)')
const nd = join(dir, 'notews')
mkdirSync(nd, { recursive: true })
writeWorkspace(nd, { surfaces: [{ id: 'n1', kind: 'native', component: 'note', title: 'todo', x: 0, y: 0, w: 200, h: 200, z: 1, props: { text: 'buy milk', color: 'pink' } }], camera: { x: 0, y: 0, scale: 1 } })
const before = readWorkspace(nd).surfaces.find((s) => s.id === 'n1')
ok('default note hydrates NATIVE (no blitz-note.html)', before.kind === 'native' && before.component === 'note' && before.props.text === 'buy milk')
ensureSystemRenderer(nd, 'note') // = customizing: the renderer file now exists
const after = readWorkspace(nd).surfaces.find((s) => s.id === 'n1')
ok('with blitz-note.html → note hydrates as a srcdoc widget (role:note)', after.kind === 'srcdoc' && after.role === 'note' && (after.html || '').includes('blitz.setProps'))
ok('the note text is the widget prop', after.props.text === 'buy milk' && after.props.color === 'pink')
writeWorkspace(nd, { surfaces: [{ ...after, props: { text: 'buy oat milk', color: 'pink' } }], camera: { x: 0, y: 0, scale: 1 } })
const round = readWorkspace(nd).surfaces.find((s) => s.id === 'n1')
ok('editing the srcdoc note persists back to its .md (role:note → node kind note)', round.props.text === 'buy oat milk')
ok('blitz-note.html is a recognized system file (no double-tile)', isSystemFile('blitz-note.html') && systemRoleOf('blitz-note.html') === 'note')

rmSync(dir, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
