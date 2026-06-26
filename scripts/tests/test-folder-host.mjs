// #52 — end-to-end proof of the WIRING: the shared workspace host's group() does flush → mkdir+mv →
// reconcile, with the new folder broadcast to renderers. Drives the real host with a fake adapter +
// a real temp dir (the host is transport-agnostic; this is exactly what backend.mjs / osActions call).
import { createWorkspaceHost } from '../../src/main/workspace-host.mjs'
import { chatFileName } from '../../src/main/workspace.mjs'
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.BLITZ_CHAT_STATUS_QUIET_MS = '20'
process.env.BLITZ_CHAT_TERMINAL_ACTIVITY_THROTTLE_MS = '100'
process.env.BLITZ_CHAT_TERMINAL_WORK_MS = '250'
process.env.BLITZ_CHAT_POST_SAY_SETTLE_MS = '30'
process.env.BLITZ_CHAT_POST_SAY_TERMINAL_WORK_MS = '60'
process.env.BLITZ_CHAT_CLAUDE_END_TURN_POLL_MS = '10'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}
const note = (id, text) => ({ id, kind: 'native', component: 'note', x: 0, y: 0, w: 300, h: 200, z: 1, title: id, props: { text } })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const root = mkdtempSync(join(tmpdir(), 'aos-host-'))
process.env.CLAUDE_CONFIG_DIR = join(root, '.claude')
let osState = { surfaces: [], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' }
const broadcasts = []
const host = createWorkspaceHost({
  root,
  initialName: 'Home',
  getState: () => osState,
  setState: (s) => {
    osState = s
  },
  broadcast: (o) => broadcasts.push(o),
  defaultMode: 'desktop'
})
const ws = host.activePath()
const md = () => readdirSync(ws).filter((n) => n.endsWith('.md') && n !== 'BLITZOS.md')
const asst = (stop, text = 'ok') => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop } })
// A Claude Code API-error record: isApiErrorMessage on an assistant record that (note) still carries a CLEAN
// stop_reason — the BLI-40 signal that stop_reason alone can't detect.
const apiErr = (text) => JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'unknown', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'stop_sequence' } })
const user = (text) => JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } })
const claudeJsonl = (sid) => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', ws.replace(/[/.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  return join(dir, `${sid}.jsonl`)
}
const attachClaudeSession = (id, sid) => {
  const mp = join(ws, '.blitzos', 'terminals', String(id), 'meta.json')
  const meta = JSON.parse(readFileSync(mp, 'utf8'))
  writeFileSync(mp, JSON.stringify({ ...meta, agentRuntime: 'claude', claudeSessionId: sid }, null, 2))
}

console.log('workspace-host.group — end-to-end (the path backend /group + Cmd+G hit):')
// the renderer "pushed" a board with 3 notes
osState = { surfaces: [note('a', '# A'), note('b', '# B'), note('c', '# C')], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' }

const r = host.group('My Folder', ['a', 'b'], 0, 0)
ok('host.group ok, moved 2', r && r.ok && r.moved === 2, r)
ok('a real subdir exists with the 2 moved notes', existsSync(join(ws, r.folder)) && readdirSync(join(ws, r.folder)).filter((n) => n.endsWith('.md')).length === 2, r.folder)
ok('the 2 grouped notes left the workspace root (real mv)', md().length === 1, md())

// the host should have BROADCAST a reconcile so renderers swap the loose tiles for one folder tile
const reconciles = broadcasts.filter((b) => b && b.type === 'reconcile')
ok('a reconcile was broadcast to renderers', reconciles.length >= 1, broadcasts.map((b) => b.type))
const last = reconciles[reconciles.length - 1]
const dirTiles = (last?.surfaces || []).filter((s) => s.component === 'dir')
const looseNotes = (last?.surfaces || []).filter((s) => s.component === 'note')
ok('the broadcast carries ONE folder tile', dirTiles.length === 1, dirTiles.map((t) => t.title))
ok('the broadcast no longer carries the 2 grouped notes (only the loose one)', looseNotes.length === 1, looseNotes.map((t) => t.title))

console.log('\nworkspace-host.newFolder — "New Folder" / "New Board" from the right-click menu:')
const nf = host.newFolder('Documents', 'folder', 0, 0)
ok('newFolder ok (normal file folder)', nf && nf.ok && existsSync(join(ws, nf.folder)) && !nf.folder.endsWith('.board'), nf)
const nb = host.newFolder('Stage', 'board', 0, 0)
ok('newBoard ok (.board suffix → on-canvas folder)', nb && nb.ok && nb.folder.endsWith('.board') && existsSync(join(ws, nb.folder)), nb)
const afterNew = broadcasts.filter((b) => b && b.type === 'reconcile').pop()
ok('New Folder broadcasts a reconcile carrying the normal folder as a dir tile', (afterNew?.surfaces || []).some((s) => s.component === 'dir' && s.props?.path === nf.folder))

console.log('\nworkspace-host.ingestPaths — drop real files/folders (Electron path):')
const ext = mkdtempSync(join(tmpdir(), 'aos-ext-'))
mkdirSync(join(ext, 'repo', 'src'), { recursive: true })
writeFileSync(join(ext, 'repo', 'index.js'), 'x')
writeFileSync(join(ext, 'repo', 'src', 'a.js'), 'y')
writeFileSync(join(ext, 'pic.png'), Buffer.from([1, 2, 3]))
const ip = host.ingestPaths([join(ext, 'repo'), join(ext, 'pic.png')], 100, 100)
ok('ingestPaths copied 2 entries', ip && ip.ok && ip.copied === 2, ip)
ok('the repo landed as a real recursive subdir', existsSync(join(ws, 'repo', 'src', 'a.js')))
ok('the file landed in the workspace root', existsSync(join(ws, 'pic.png')))
const afterIngest = broadcasts.filter((b) => b && b.type === 'reconcile').pop()
ok('dropped repo broadcasts as ONE collapsed dir tile (not its files)', (afterIngest?.surfaces || []).some((s) => s.component === 'dir' && s.props?.path === 'repo') && !(afterIngest?.surfaces || []).some((s) => s.props?.path === 'repo/index.js'))

console.log('\nworkspace-host.ingestUpload — server folder upload (subpath, deferred reconcile):')
host.ingestUpload('dropped/sub/a.txt', Buffer.from('A'), 0, 0, false)
host.ingestUpload('dropped/b.txt', Buffer.from('B'), 0, 0, false)
ok('subpath uploads wrote a nested real tree', existsSync(join(ws, 'dropped', 'sub', 'a.txt')) && existsSync(join(ws, 'dropped', 'b.txt')))
const beforeRec = broadcasts.filter((b) => b && b.type === 'reconcile').length
host.reconcileAt(200, 200)
ok('the trailing reconcileAt broadcasts once', broadcasts.filter((b) => b && b.type === 'reconcile').length === beforeRec + 1)

console.log('\nworkspace-host.listDir — the file-manager listing (jailed):')
const ld = host.listDir('repo')
ok('lists the dropped repo contents', !!ld && ld.entries.some((e) => e.name === 'index.js') && ld.entries.some((e) => e.dir && e.name === 'src'))
ok('listDir jails ".." → null', host.listDir('..') === null)

console.log('\nworkspace-host chat — file-backed widget (appendChat → chat.md + broadcast):')
osState = { surfaces: [{ id: 'chat', kind: 'srcdoc', role: 'chat', x: 0, y: 0, w: 360, h: 460, z: 5, props: { messages: [] } }], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' }
const chatProps = () => osState.surfaces.find((s) => s.role === 'chat')?.props || {}
const m1 = host.appendChat('user', 'hello chat')
ok('appendChat writes the transcript', existsSync(join(ws, chatFileName())) && m1.length === 1 && m1[0].text === 'hello chat', m1)
ok('appendChat broadcasts {type:chat, messages}', broadcasts.some((b) => b && b.type === 'chat' && Array.isArray(b.messages) && b.messages.length === 1))
ok('appendChat syncs osState chat surface props (fresh hydrate shows it)', (osState.surfaces.find((s) => s.role === 'chat')?.props?.messages || []).length === 1)
ok('appendChat exposes hub threads', Array.isArray(osState.surfaces.find((s) => s.role === 'chat')?.props?.threads?.['0']))
host.appendChat('agent', 'Generated app: Demo Dashboard', '0', {
  parts: [{ type: 'app', title: 'Demo Dashboard', url: 'https://demo-dashboard.app.blitz.dev/', icon: 'dashboard', tone: 'sky' }]
})
ok('appendChat exposes typed app parts through hub threads', chatProps().threads?.['0']?.some((m) => m.parts?.[0]?.type === 'app' && m.parts?.[0]?.url === 'https://demo-dashboard.app.blitz.dev/'), chatProps().threads?.['0'])
ok('user chat marks the agent working', chatProps().status?.['0'] === 'working', chatProps().status)
host.appendChat('agent', 'hi there')
ok('agent /say keeps the turn briefly open', chatProps().status?.['0'] === 'working', chatProps().status)
await sleep(45)
ok('agent /say settles after the post-reply grace window', chatProps().status?.['0'] === 'watching', chatProps().status)
host.noteAgentActivity('0', 'terminal')
ok('terminal output after a settled reply stays passive', chatProps().status?.['0'] === 'watching', chatProps().status)
host.noteAgentActivity('0', 'tool')
ok('tool activity keeps the agent working', chatProps().status?.['0'] === 'working', chatProps().status)
await sleep(45)
ok('quiet running agent transitions to watching', chatProps().status?.['0'] === 'watching', chatProps().status)
host.addAgent('3', 'Agent 3')
host.appendChat('user', 'keep working after a progress note', '3')
host.appendChat('agent', 'I found the first issue and I am checking the rest.', '3')
ok('post-reply agent remains working during the settle window', chatProps().status?.['3'] === 'working', chatProps().status)
host.noteAgentActivity('3', 'terminal')
ok('terminal output during the settle window keeps the agent working', chatProps().status?.['3'] === 'working', chatProps().status)
await sleep(45)
ok('continued terminal work keeps the agent working past the quiet timeout', chatProps().status?.['3'] === 'working', chatProps().status)
await sleep(70)
ok('post-reply terminal continuation settles before the full terminal-work lease', chatProps().status?.['3'] === 'watching', chatProps().status)
host.addAgent('4', 'Agent 4')
host.appendChat('user', 'reply after a pause, then keep working', '4')
await sleep(45)
ok('quiet delayed reply turn demotes before the first reply', chatProps().status?.['4'] === 'watching', chatProps().status)
host.appendChat('agent', 'I have a direction and I am checking it now.', '4')
ok('delayed reply still reopens the post-reply working window', chatProps().status?.['4'] === 'working', chatProps().status)
host.noteAgentActivity('4', 'terminal')
ok('terminal output after a delayed reply keeps the agent working', chatProps().status?.['4'] === 'working', chatProps().status)
host.addAgent('5', 'Agent 5')
host.appendChat('user', 'ask me to choose', '5')
host.appendChat('agent', '```blitz-ui\n{"type":"choice","prompt":"Pick one","options":["A","B"]}\n```', '5')
ok('blitz-ui choice prompts mark the agent response-needed', chatProps().status?.['5'] === 'waiting', chatProps().status)
await sleep(45)
ok('response-needed status survives quiet timeout', chatProps().status?.['5'] === 'waiting', chatProps().status)
host.noteAgentActivity('5', 'terminal')
host.noteAgentActivity('5', 'tool')
ok('terminal/tool noise does not clear response-needed status', chatProps().status?.['5'] === 'waiting', chatProps().status)
host.appendChat('user', 'A', '5')
ok('user response clears response-needed status and wakes the agent', chatProps().status?.['5'] === 'working', chatProps().status)
host.addAgent('6', 'Agent 6')
host.appendChat('user', 'scan HN', '6')
host.appendChat('agent', "The HN scan is complete and delivered. I'm idle now, watching for your next message.", '6')
ok('explicit idle final reply settles immediately instead of lingering working', chatProps().status?.['6'] === 'watching', chatProps().status)
host.noteAgentActivity('6', 'terminal')
ok('terminal noise after explicit idle final reply stays passive', chatProps().status?.['6'] === 'watching', chatProps().status)
host.addAgent('7', 'Agent 7')
host.appendChat('user', 'scan a lot, then report back', '7')
host.noteAgentActivity('7', 'terminal')
ok('pre-reply terminal output marks the agent working', chatProps().status?.['7'] === 'working', chatProps().status)
host.appendChat('agent', 'The scan is complete.', '7')
await sleep(90)
ok('agent reply shrinks existing terminal work and settles before the full lease', chatProps().status?.['7'] === 'watching', chatProps().status)
host.addAgent('8', 'Agent 8')
attachClaudeSession('8', 's-clean')
writeFileSync(claudeJsonl('s-clean'), user('old') + '\n' + asst('end_turn', 'old done') + '\n')
host.appendChat('user', 'do one thing and stop', '8')
host.noteAgentActivity('8', 'terminal')
appendFileSync(claudeJsonl('s-clean'), user('do one thing and stop') + '\n' + asst('end_turn', 'new done') + '\n')
host.appendChat('agent', 'Done.', '8')
ok('fresh Claude end_turn settles the agent immediately', chatProps().status?.['8'] === 'watching', chatProps().status)
host.addAgent('9', 'Agent 9')
attachClaudeSession('9', 's-stale')
writeFileSync(claudeJsonl('s-stale'), user('old') + '\n' + asst('end_turn', 'old done') + '\n')
host.appendChat('user', 'do one more thing', '9')
host.noteAgentActivity('9', 'terminal')
host.appendChat('agent', 'I am checking that now.', '9')
ok('stale Claude end_turn from a prior turn is ignored', chatProps().status?.['9'] === 'working', chatProps().status)
host.addAgent('10', 'Agent 10')
attachClaudeSession('10', 's-late-clean')
writeFileSync(claudeJsonl('s-late-clean'), user('old') + '\n' + asst('end_turn', 'old done') + '\n')
host.appendChat('user', 'finish after the say arrives', '10')
host.noteAgentActivity('10', 'terminal')
setTimeout(() => appendFileSync(claudeJsonl('s-late-clean'), user('finish after the say arrives') + '\n' + asst('end_turn', 'late done') + '\n'), 1)
host.appendChat('agent', 'Done.', '10')
ok('Claude agent remains working until the delayed end_turn lands', chatProps().status?.['10'] === 'working', chatProps().status)
await sleep(20)
ok('delayed Claude end_turn settles before the full post-reply window', chatProps().status?.['10'] === 'watching', chatProps().status)
host.addAgent('11', 'Agent 11')
attachClaudeSession('11', 's-apierr')
writeFileSync(claudeJsonl('s-apierr'), user('old') + '\n' + asst('end_turn', 'old done') + '\n')
host.appendChat('user', 'trigger a rate limit', '11')
appendFileSync(claudeJsonl('s-apierr'), user('trigger a rate limit') + '\n' + apiErr('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited') + '\n')
await sleep(130)
ok('fresh Claude API error (clean stop_reason) flips the agent to error', chatProps().status?.['11'] === 'error', chatProps().status)
host.noteAgentActivity('11', 'terminal')
ok('error status is sticky against later terminal noise', chatProps().status?.['11'] === 'error', chatProps().status)
host.appendChat('user', 'are you back?', '11')
ok('a new user message clears the error back to working', chatProps().status?.['11'] === 'working', chatProps().status)
host.appendChat('user', 'run a long shell task')
await sleep(120)
ok('quiet user turn without terminal output settles to watching', chatProps().status?.['0'] === 'watching', chatProps().status)
host.noteAgentActivity('0', 'terminal')
ok('terminal output after a recent user turn restores working', chatProps().status?.['0'] === 'working', chatProps().status)
await sleep(45)
ok('contextual terminal output keeps working past the quiet timeout', chatProps().status?.['0'] === 'working', chatProps().status)
ok('both roles append in order', host.appendChat('user', 'x').slice(0, 2).map((m) => m.role).join() === 'user,agent')
const added = host.addAgent('1', 'Agent 1')
ok('new agent starts ready instead of warmup', added.id === '1' && chatProps().status?.['1'] === 'idle', chatProps().status)
host.setChatStatus('1', 'starting')
host.noteAgentActivity('1', 'terminal')
ok('existing-agent startup terminal output keeps warmup status', chatProps().status?.['1'] === 'starting', chatProps().status)
host.noteAgentActivity('1', 'say')
host.appendChat('agent', 'BlitzOS here, live on your desktop. What are we working on?', '1')
ok('startup ready message settles to watching', chatProps().status?.['1'] === 'watching', chatProps().status)
host.noteAgentActivity('1', 'terminal')
ok('passive wait-loop terminal output stays watching', chatProps().status?.['1'] === 'watching', chatProps().status)
await sleep(45)
ok('quiet new agent becomes watching', chatProps().status?.['1'] === 'watching', chatProps().status)
host.addAgent('2', 'Agent 2')
host.noteWorkflowRun('2', 'wf-1', true)
await sleep(45)
ok('active workflow keeps agent working past the quiet timeout', chatProps().status?.['2'] === 'working', chatProps().status)
host.noteWorkflowRun('2', 'wf-1', false)
ok('workflow completion recomputes away from working', chatProps().status?.['2'] !== 'working', chatProps().status)
host.setChatStatus('1', 'stopped')
ok('terminal stop marks stopped immediately', chatProps().status?.['1'] === 'stopped', chatProps().status)
host.setChatStatus('1', 'error')
ok('terminal failure marks error immediately', chatProps().status?.['1'] === 'error', chatProps().status)

console.log('\nworkspace-host customizeWidget — the agent rewrites the chat UI (live-reload):')
const cu = host.customizeWidget('chat', '<blitz-titlebar>Custom Chat</blitz-titlebar>')
ok('customizeWidget writes blitz-chat.html', cu.ok && readFileSync(join(ws, 'blitz-chat.html'), 'utf8').includes('Custom Chat'))
ok('customizeWidget broadcasts a live-reload update for the chat', broadcasts.some((b) => b && b.type === 'update' && b.id === 'chat' && (b.patch?.html || '').includes('Custom Chat')))
ok('systemUi returns the customized source', (host.systemUi('chat') || '').includes('Custom Chat'))
ok('customize rejects an unknown widget', host.customizeWidget('nope', 'x').ok === false)

// and it persists: a fresh read of the folder shows the folder tile (real directory on disk)
host.stopWatch?.()
rmSync(ext, { recursive: true, force: true })
rmSync(root, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
