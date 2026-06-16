#!/usr/bin/env node
// Seed test for the onboarding board planner (plans/onboarding-case-file.md P1): scan.json
// fixtures → buildBoardPlan → assert STAGE-LATTICE placement (content-driven slot sizes, live
// occupancy incl. the chat hub, shrink-then-park overflow), props shape, and invariants.
// No Electron, no model. Run: node scripts/test-onboarding-seed.mjs
import { buildBoardPlan, unlockCardProps, findUnlockSlot, UNLOCK_SIZE } from '../../src/main/onboarding-board.mjs'
import { latticeFor, spanOf } from '../../src/renderer/src/stage-core.mjs'
import { stageRect } from '../../src/renderer/src/stages-core.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.env.BLITZ_WIDGETS_DIR = process.env.BLITZ_WIDGETS_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'widgets')
const { getWidgetSource } = await import('../../src/main/widget-catalog.mjs')

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}
const at = (plan, role) => plan.find((c) => c.role === role)
const VP = { w: 1600, h: 1000 }
const CHAT_HUB = { id: 'chat', slot: { col: 0, row: 0, size: 'tall' }, slotStage: 0 }

/** Every cell each staged thing covers; duplicates = an overlap (the cardinal lattice sin). */
function cellsOf(items) {
  const seen = new Map()
  let clash = null
  for (const it of items) {
    if (!it.slot) continue
    const sp = spanOf(it.slot.size)
    for (let r = it.slot.row; r < it.slot.row + sp.r; r++)
      for (let c = it.slot.col; c < it.slot.col + sp.c; c++) {
        const k = `${c}:${r}`
        if (seen.has(k)) clash = `${seen.get(k)} overlaps ${it.role || it.id} at ${k}`
        seen.set(k, it.role || it.id)
      }
  }
  return { count: seen.size, clash }
}

// A realistic engineer scan, FDA OFF: no calendar/messages/mail/contacts data exists yet.
const FIXTURE = {
  meta: { v: 2, generatedAt: 1781000000000, fda: false, spanDays: 90, nText: 1200, nEvents: 800, fdaLocked: ['knowledgeC', 'safari', 'contacts', 'messages', 'mail', 'calendar', 'notes', 'accounts'] },
  identity: { name: 'Ada', handle: 'ada-l', computer: 'Ada’s MacBook', locale: { locale: 'en_GB' }, defaultBrowser: 'com.google.chrome' },
  cadence: {
    peakHours: [10, 15, 21],
    activeWeekdays: ['Tue', 'Wed', 'Thu'],
    punch: { '2:10': 5, '3:15': 9, '4:21': 3 },
    topApps: [],
    appLaunches: [{ app: 'Terminal', n: 40 }, { app: 'Chrome', n: 22 }]
  },
  projects: [
    { name: 'analytical-engine', prompts: 300 },
    { name: 'notes-on-bernoulli', prompts: 120 }
  ],
  repos: ['analytical-engine', 'side-quest'],
  stack: [{ name: 'typescript', n: 40 }],
  tooling: [{ tool: 'git', n: 200 }, { tool: 'node', n: 90 }],
  people: [
    { label: 'Charles Babbage', n: 12, kind: 'name', via: 'commits' },
    { label: 'Mary Somerville', n: 4, kind: 'name', via: 'commits' }
  ],
  calendar: { upcoming: [], meetingsPerWeek: 0 },
  census: [{ kind: 'PDFs', n: 80 }, { kind: 'slides', n: 12 }],
  web: { webFirst: false, visits: 900, devSignals: 1100, workflow: [{ host: 'github.com', name: 'GitHub', n: 50, color: '#24292F', integration: 'github' }, { host: 'docs.google.com', name: 'Google Docs', n: 20, color: '#4285F4' }, { host: 'x.com', name: 'X', n: 15, color: '#0F1419' }] },
  voice: [{ text: 'Brevity over flourish, always.', source: 'claude' }],
  sessions: [{ title: 'Port the engine to TS', agent: 'claude', last: 1780900000000, project: 'analytical-engine' }],
  facts: { dock: ['Terminal', 'Chrome'], installedApps: 120, accounts: [] },
  gaps: ['Autonomy preference, act vs ask?', 'Goals for the quarter']
}

console.log('1) engineer fixture, FDA off, chat hub on stage — FIT-FIRST: everything staged compact, growth into leftovers')
{
  const plan = buildBoardPlan(FIXTURE, { surfaces: [CHAT_HUB], viewport: VP })
  const roles = plan.map((c) => c.role)
  ok(roles.join(',') === 'profile,projects,rhythm,gaps,unlock,workflows,sessions', `priority order incl. the unlock reservation (got ${roles.join(',')})`)
  ok(plan.every((c) => c.slot), 'fit-first: at the default viewport EVERY card is a slotted tile, zero parked')
  const staged = plan.filter((c) => c.slot)
  const { clash } = cellsOf([CHAT_HUB, ...staged])
  ok(!clash, `no span overlaps another tile or the chat hub${clash ? ` (${clash})` : ''}`)
  const lat = latticeFor(VP, 0)
  ok(staged.every((c) => c.slot.col >= 0 && c.slot.row >= 0 && c.slot.col + spanOf(c.slot.size).c <= lat.cols && c.slot.row + spanOf(c.slot.size).r <= lat.rows), 'every span sits inside the lattice')
  ok(at(plan, 'profile').slot.size === 'l', 'profile grew to l (priority upgrade into free cells)')
  ok(at(plan, 'projects').slot.size === 'xl', 'projects grew to the xl hero (free cells allowed it)')
  ok(at(plan, 'workflows').slot.size === 'm', 'workflows with 3 items stays a gist tile (m)')
  ok(at(plan, 'gaps').slot.size === 'm', 'gaps with 3 items stays m')
  ok(at(plan, 'unlock') && at(plan, 'unlock').native === 'unlock' && at(plan, 'unlock').slot, 'unlock card is part of the plan, slotted right after gaps')
  ok(at(plan, 'gaps').props.items.some((g) => g.q === 'The personal layer'), 'gaps includes the FDA unlock teaser when locked')
  ok(at(plan, 'rhythm').props.topApps[0].n === 40, 'rhythm falls back to launch counts when knowledgeC is locked')
  ok(plan.filter((c) => c.role !== 'unlock').every((c) => typeof c.props.accent === 'string'), 'every widget card samples an accent from the palette')
  // The picked theme (2026-06-11) rotates FOUR colors (slate, dusty blue, sage, marker) instead of
  // the old 7-accent palette — assert a distribution, not the old palette size.
  ok(new Set(plan.filter((c) => c.props.accent).map((c) => c.props.accent)).size >= 3, 'accents vary across the board (a distribution, not one color)')
  ok(!JSON.stringify(plan.map((c) => c.props)).includes('—'), 'no em dash anywhere a human reads')
  for (const card of plan) {
    const size = JSON.stringify(card.props).length
    ok(size <= 8192, `${card.role} props fit the 8KB persistence cap (${size}b)`)
  }
  ok(plan.filter((c) => c.widget).every((c) => getWidgetSource(c.widget)), 'every planned widget resolves in the catalog')
}

console.log('2) FDA on, meeting-heavy — schedule joins, unlock stays out of the plan')
{
  const fdaScan = {
    ...FIXTURE,
    meta: { ...FIXTURE.meta, fda: true, fdaLocked: [] },
    cadence: { ...FIXTURE.cadence, topApps: [{ app: 'com.apple.Terminal', secs: 7200 }] },
    calendar: {
      upcoming: [
        { title: 'Design review', start: 1781100000000, allDay: false, attendees: true },
        { title: 'Lunch w/ Mary', start: 1781190000000, allDay: false, attendees: true },
        { title: 'Conference', start: 1781280000000, allDay: true, attendees: false }
      ],
      meetingsPerWeek: 6.5
    },
    people: [{ label: 'Luigi M.', n: 22, kind: 'name', via: 'messages' }, ...FIXTURE.people] // scan emits topN-sorted
  }
  const plan = buildBoardPlan(fdaScan, { surfaces: [CHAT_HUB], viewport: VP })
  ok(!at(plan, 'unlock'), 'no unlock card when FDA is already granted')
  ok(plan.every((c) => c.slot), 'every present card staged (fit-first)')
  ok(at(plan, 'schedule') && at(plan, 'schedule').slot.size === 'm', 'schedule with 3 events is m')
  ok(/\w{3} \d{2}:\d{2}/.test(at(plan, 'schedule').props.items[0].time), 'schedule items carry weekday+time')
  ok(at(plan, 'profile').props.facts.some((f) => f.k === 'Meetings'), 'profile gains a meetings fact')
  ok(at(plan, 'rhythm').props.topApps[0].secs === 7200, 'rhythm uses real focus time')
  ok(!at(plan, 'gaps').props.items.some((g) => g.q === 'The personal layer'), 'gaps drops the unlock teaser')
  const { clash } = cellsOf([CHAT_HUB, ...plan.filter((c) => c.slot)])
  ok(!clash, 'still zero overlaps with more cards on the lattice')
}

console.log('3) web-first life — workflows wins the prime spans, projects yields')
{
  const webScan = {
    ...FIXTURE,
    meta: { ...FIXTURE.meta, fda: true, fdaLocked: [] },
    projects: [],
    repos: [],
    tooling: [],
    stack: [],
    web: {
      webFirst: true,
      visits: 4000,
      devSignals: 40,
      workflow: [
        { host: 'mail.google.com', name: 'Gmail', n: 300, color: '#EA4335', integration: 'gmail' },
        { host: 'notion.so', name: 'Notion', n: 200, color: '#191919' },
        { host: 'app.slack.com', name: 'Slack', n: 150, color: '#611F69', integration: 'slack' },
        { host: 'canva.com', name: 'Canva', n: 90, color: '#00C4CC' },
        { host: 'linkedin.com', name: 'LinkedIn', n: 70, color: '#0A66C2' },
        { host: 'airtable.com', name: 'Airtable', n: 60, color: '#FCB400' }
      ]
    }
  }
  const plan = buildBoardPlan(webScan, { surfaces: [CHAT_HUB], viewport: VP })
  const wf = at(plan, 'workflows')
  ok(plan[1] && plan[1].role === 'workflows', 'workflows is placed second (right after profile), winning the prime spans')
  ok(wf.slot && wf.slot.size === 'tall', 'workflows with 6 items is tall (list-shaped)')
  ok(wf.props.title === 'Where your work lives', 'web-first workflows gets the web-first title')
  ok(wf.props.items.filter((i) => i.integration).length === 2, 'connectable integrations marked')
  ok(!at(plan, 'projects'), 'no projects card for a web-first life')
}

console.log('4) tiny lattice — shrink first, then park off-stage below the frame (never overlap)')
{
  const smallVP = { w: 800, h: 600 }
  const plan = buildBoardPlan(FIXTURE, { surfaces: [], viewport: smallVP })
  const staged = plan.filter((c) => c.slot)
  const parked = plan.filter((c) => c.offstage)
  ok(staged.length >= 1, `something still makes the tiny stage (${staged.length} staged)`)
  ok(parked.length >= 1, `overflow parks off-stage instead of overlapping (${parked.length} parked)`)
  const r = stageRect(0, smallVP)
  ok(parked.every((c) => c.y >= r.y + r.h && typeof c.w === 'number' && typeof c.h === 'number'), 'parked cards sit BELOW the stage frame with real dims')
  const { clash } = cellsOf(staged)
  ok(!clash, 'no overlaps even under pressure')
  // backstage is a clean grid too: no parked card may overlap another (the 64px-cascade pile bug)
  const rectClash = parked.some((a, i) => parked.some((b, j) => j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h))
  ok(!rectClash, 'parked cards never overlap each other')
  ok(staged.every((c) => ['s', 'm', 'l', 'tall', 'xl', 'xxl'].includes(c.slot.size)), 'staged sizes are legal spans')
}

console.log('5) sparse scan — profile + gaps + unlock only, never crashes')
{
  const empty = {
    meta: { v: 2, generatedAt: 0, fda: false, spanDays: 1, nText: 0, nEvents: 0, fdaLocked: [] },
    identity: { name: null, handle: null, computer: null, locale: {}, defaultBrowser: null },
    cadence: { peakHours: [], activeWeekdays: [], punch: {}, topApps: [], appLaunches: [] },
    projects: [], repos: [], stack: [], tooling: [],
    people: [{ label: 'Solo Dev', n: 1, kind: 'name', via: 'commits' }],
    calendar: { upcoming: [], meetingsPerWeek: 0 },
    census: [],
    web: { webFirst: false, visits: 0, devSignals: 0, workflow: [] },
    voice: [], sessions: [],
    facts: { dock: [], installedApps: 0, accounts: [] },
    gaps: []
  }
  const plan = buildBoardPlan(empty, { surfaces: [CHAT_HUB], viewport: VP })
  const roles = plan.map((c) => c.role)
  ok(roles.join(',') === 'profile,gaps,unlock', `everything empty skips, the spine stays (got ${roles.join(',')})`)
  ok(at(plan, 'profile').props.name === 'Unknown subject', 'nameless scan degrades gracefully')
}

console.log('6) malformed scan sections — planner skips, never throws')
{
  const broken = JSON.parse(JSON.stringify(FIXTURE))
  broken.cadence = null
  broken.web = null
  let plan = null
  try {
    plan = buildBoardPlan(broken, { surfaces: [CHAT_HUB], viewport: VP })
  } catch {
    /* must not throw */
  }
  ok(Array.isArray(plan), 'planner returns a plan despite broken sections')
  ok(plan && !at(plan, 'rhythm') && !at(plan, 'workflows'), 'broken cards are skipped')
  ok(plan && at(plan, 'projects'), 'healthy cards survive')
}

console.log('7) unlock card contract')
{
  const p = unlockCardProps('Electron')
  ok(p.state === 'locked' && p.appName === 'Electron' && Array.isArray(p.sources) && p.sources.length >= 4, 'unlock props complete')
  ok(UNLOCK_SIZE === 'l', 'unlock prefers a l span')
  const slotted = findUnlockSlot([CHAT_HUB], VP)
  ok(slotted && slotted.slot && slotted.slotStage === 0, 'findUnlockSlot lands a span against live surfaces')
  // a saturated tiny lattice (an xxl tile owns it) → no span at all → null (caller parks)
  const full = findUnlockSlot([{ id: 'big', slot: { col: 0, row: 0, size: 'xxl' }, slotStage: 0 }], { w: 700, h: 500 })
  ok(full === null, 'a truly full stage returns null instead of overlapping')
}

console.log('8) live working set — the open-tabs card is placed, populated, and never overlaps')
{
  const tabsScan = {
    ...FIXTURE,
    web: {
      webFirst: true,
      visits: 4000,
      devSignals: 1100,
      workflow: [{ host: 'github.com', name: 'GitHub', n: 50, integration: 'github' }],
      openTabs: {
        browser: 'Google Chrome',
        capturedAt: 1781000000000,
        counts: { windows: 2, tabs: 9 },
        windows: [
          { tabs: [
            { title: 'analytical-engine — live dashboard', host: 'app.example.com', url: 'https://app.example.com/x' },
            { title: 'Apply to Y Combinator', host: 'apply.ycombinator.com', url: 'https://apply.ycombinator.com' },
            { title: 'Bernoulli numbers paper', host: 'arxiv.org', url: 'https://arxiv.org/abs/1' },
            { title: 'New chat - Claude', host: 'claude.ai', url: 'https://claude.ai/new' },
            { title: 'D1 SQLite', host: 'dash.cloudflare.com', url: 'https://dash.cloudflare.com/d1' },
            { title: 'Deploy', host: 'vercel.com', url: 'https://vercel.com/deploy' }
          ] },
          { tabs: [
            { title: 'Radial menu manual', host: 'doc.plasticity.xyz', url: 'https://doc.plasticity.xyz/radial' },
            { title: 'Pie menus tutorial', host: 'youtube.com', url: 'https://youtube.com/watch?v=1' },
            { title: 'Claude Platform', host: 'platform.claude.com', url: 'https://platform.claude.com' }
          ] }
        ]
      }
    }
  }
  const plan = buildBoardPlan(tabsScan, { surfaces: [CHAT_HUB], viewport: VP })
  const wt = at(plan, 'worktabs')
  ok(wt, 'worktabs card is in the plan when open tabs were captured')
  ok(wt && wt.widget === 'worktabs', 'worktabs maps to the worktabs widget')
  ok(wt && Array.isArray(wt.props.items) && wt.props.items.length === 9, `worktabs lists every captured tab (got ${wt && wt.props.items && wt.props.items.length})`)
  ok(wt && wt.props.items[0].url && wt.props.items[0].win === 1, 'tab items carry their exact url + window index')
  ok(wt && /9 tabs · 2 windows · Google Chrome/.test(wt.props.sub || ''), `worktabs sub summarizes the set (got "${wt && wt.props.sub}")`)
  ok(wt && (wt.slot ? wt.slot.size === 'tall' || wt.slot.size === 'l' : wt.offstage), 'worktabs is list-shaped (tall/l) when staged, else parked')
  const { clash } = cellsOf(plan.filter((c) => c.slot).concat([CHAT_HUB]))
  ok(!clash, `worktabs never overlaps another tile or the chat hub${clash ? ` (${clash})` : ''}`)
  // no openTabs → no worktabs card (graceful: Automation denied / no browser)
  const noTabs = { ...tabsScan, web: { ...tabsScan.web, openTabs: null } }
  ok(!at(buildBoardPlan(noTabs, { surfaces: [CHAT_HUB], viewport: VP }), 'worktabs'), 'no open-tabs snapshot → no worktabs card')
  // the widget source exists + is registered
  ok(!!getWidgetSource('worktabs'), 'worktabs widget is registered in the manifest + has source')
}

console.log('9) projects card is developer-only — a non-dev with a stray repo/session gets none')
{
  // A non-coder who happens to have one old repo on disk and a single low-prompt "project": every
  // isDeveloper branch is false (stack 0, promptedProjects 0 (<5), repos 1 (<2), devSignals 0).
  const nonDev = {
    meta: { v: 2, generatedAt: 0, fda: true, spanDays: 30, nText: 50, nEvents: 40, fdaLocked: [] },
    identity: { name: 'Grace', handle: null, computer: 'Grace’s Mac', locale: {}, defaultBrowser: 'com.apple.Safari' },
    cadence: { peakHours: [9], activeWeekdays: ['Mon'], punch: { '1:9': 3 }, topApps: [], appLaunches: [{ app: 'Mail', n: 12 }] },
    projects: [{ name: 'budget', prompts: 1 }],
    repos: ['old-thing'], stack: [], tooling: [],
    people: [],
    calendar: { upcoming: [], meetingsPerWeek: 0 },
    census: [],
    web: { webFirst: false, visits: 200, devSignals: 0, workflow: [] },
    voice: [], sessions: [{ title: 'tinker', agent: 'claude', last: 0, project: 'budget' }],
    facts: { dock: [], installedApps: 30, accounts: [] },
    gaps: ['What do you want help with?']
  }
  const plan = buildBoardPlan(nonDev, { surfaces: [CHAT_HUB], viewport: VP })
  ok(!at(plan, 'projects'), 'no projects card for a non-dev with only a stray repo + low-prompt project')
  // pin the OTHER side of the boundary: bump the stray project past the prompt floor → dev → card returns
  const devVariant = { ...nonDev, projects: [{ name: 'budget', prompts: 8 }] }
  ok(at(buildBoardPlan(devVariant, { surfaces: [CHAT_HUB], viewport: VP }), 'projects'), 'a heavily-prompted project alone makes them a developer (projects card returns)')
}

if (failed) {
  console.error(`\n✗ ${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ onboarding seed test passed')
