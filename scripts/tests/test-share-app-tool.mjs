import { makeOsToolsByPath } from '../../src/main/os-tools.mjs'

let pass = 0
let fail = 0
const ok = (name, condition, detail) => {
  if (condition) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name, detail || '')
  }
}

const calls = []
const tools = makeOsToolsByPath({
  getState: () => ({ surfaces: [] }),
  say: (text, agent, workspace) => calls.push({ type: 'say', text, agent, workspace }),
  shareApp: (app, agent, workspace) => calls.push({ type: 'shareApp', app, agent, workspace })
})

console.log('# share_app tool')
const shared = await tools['/share_app'].handler({
  body: JSON.stringify({
    title: 'HN Radar',
    url: 'https://hn-radar.app.blitz.dev/',
    subtitle: 'Live YC/HN signal dashboard',
    icon: 'table',
    tone: 'mint',
    agent: '7',
    workspace: 'Home'
  })
})
ok('share_app accepts Blitz app preview URLs', shared?.ok === true)
ok('share_app normalizes and forwards the app part', calls[0]?.type === 'shareApp' && calls[0].app?.type === 'app' && calls[0].app?.title === 'HN Radar' && calls[0].app?.url === 'https://hn-radar.app.blitz.dev/' && calls[0].app?.icon === 'table' && calls[0].app?.tone === 'mint' && calls[0].agent === '7' && calls[0].workspace === 'Home', calls[0])

const rejected = await tools['/share_app'].handler({ body: JSON.stringify({ title: 'Bad', url: 'https://example.com/' }) })
ok('share_app rejects non-Blitz URLs', rejected?.status === 400 && /app\.blitz\.dev/.test(rejected.body?.error || ''), rejected)

console.log('\n# say guard for app preview URLs')
const blockedSay = await tools['/say'].handler({ body: JSON.stringify({ text: 'Your dashboard is live: https://hn-radar.app.blitz.dev/' }) })
ok('say rejects Blitz app preview URL dumps when share_app is available', blockedSay?.status === 400 && /share_app/.test(blockedSay.body?.error || ''), blockedSay)
ok('blocked say does not append chat text', calls.filter((c) => c.type === 'say').length === 0, calls)

const blockedBareSay = await tools['/say'].handler({ body: JSON.stringify({ text: 'Open hn-radar.app.blitz.dev for the dashboard.' }) })
ok('say rejects bare Blitz app preview domains too', blockedBareSay?.status === 400 && /https:\/\/hn-radar\.app\.blitz\.dev/.test(blockedBareSay.body?.error || ''), blockedBareSay)

const normalSay = await tools['/say'].handler({ body: JSON.stringify({ text: 'The dashboard is ready. I scored stories by comments, points, and recency.', agent: '7' }) })
ok('say still accepts normal prose after the card', normalSay?.ok === true && calls.some((c) => c.type === 'say' && c.agent === '7'), calls)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
