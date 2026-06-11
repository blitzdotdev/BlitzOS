#!/usr/bin/env node
// Seed test for the onboarding board planner (plans/onboarding-case-file.md P1): scan.json
// fixtures → buildBoardPlan → assert card selection, ADAPTIVE slotting (hero swap for web-first,
// flex slots, unlock slot reservation), props shape, and invariants — no Electron, no model.
// Run: node scripts/test-onboarding-seed.mjs
import { buildBoardPlan, unlockCardProps, UNLOCK_POS } from '../src/main/onboarding-board.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.env.BLITZ_WIDGETS_DIR = process.env.BLITZ_WIDGETS_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'widgets')
const { getWidgetSource } = await import('../src/main/widget-catalog.mjs')

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}
const at = (plan, role) => plan.find((c) => c.role === role)

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
  gaps: ['How much should BlitzOS act on its own vs. ask before acting?', 'What is worth doing this quarter?']
}

console.log('1) engineer fixture, FDA off — hero=projects, people@E, workflows@F, unlock owns I')
{
  const plan = buildBoardPlan(FIXTURE)
  const roles = plan.map((c) => c.role)
  ok(roles.join(',') === 'profile,projects,rhythm,voice,sessions,people,workflows,gaps', `expected 8 cards in narrative order, no Daily-tools (got ${roles.join(',')})`)
  ok(!at(plan, 'toolbox'), 'the Daily-tools card is gone')
  ok(at(plan, 'projects').x === -225 && at(plan, 'projects').y === -390, 'projects sits in the hero slot')
  ok(at(plan, 'people').x === -225 && at(plan, 'people').y === -15, 'people takes flex slot E (freed by toolbox)')
  ok(at(plan, 'workflows').x === 240 && at(plan, 'workflows').y === 5, 'workflows takes flex slot F (no longer dropped when FDA is off)')
  ok(!plan.some((c) => c.x === UNLOCK_POS.x && c.y === UNLOCK_POS.y), 'no card occupies the unlock slot when FDA is off')
  ok(at(plan, 'people').props.items[0].sub === 'git collaborator', 'people card subtitles say HOW we know them')
  ok(at(plan, 'gaps').props.items.some((g) => g.q === 'The personal layer'), 'gaps includes the FDA unlock teaser when locked')
  ok(at(plan, 'rhythm').props.topApps[0].n === 40, 'rhythm falls back to launch counts when knowledgeC is locked')
  ok(plan.every((c) => typeof c.props.accent === 'string' && typeof c.props.accentInk === 'string'), 'every card samples an accent from the palette')
  ok(new Set(plan.map((c) => c.props.accent)).size >= 5, 'accents vary across the board (a distribution, not one color)')
  ok(at(plan, 'gaps').props.accent === '#E8C71D', 'gaps gets the marker-yellow accent')
  ok(at(plan, 'rhythm').props.heatLo === '#7FA0C8' && at(plan, 'rhythm').props.heatHi === '#FF8D61', 'rhythm carries the cool→warm heat ramp')
  ok(at(plan, 'workflows').props.items.every((i) => i.color), 'workflow items carry brand colors')
  for (const card of plan) {
    const size = JSON.stringify(card.props).length
    ok(size <= 8192, `${card.role} props fit the 8KB persistence cap (${size}b)`)
  }
  ok(plan.every((c) => getWidgetSource(c.widget)), 'every planned widget resolves in the catalog')
  // the renderer clamps creation into the primary rect (≈±682×±399 at 1440×900) — the grid must fit
  ok(plan.every((c) => c.x >= -660 && c.x + c.w <= 660 && c.y >= -390 && c.y + c.h <= 390), 'board fits the smallest common primary rect (no clamp drift)')
  // strict prose rule (plans/siri-prompt.md): board copy the human reads carries no em dashes
  ok(plan.every((c) => !JSON.stringify(c.props).includes('—')), 'no em dashes in any card copy')
  ok(!JSON.stringify(unlockCardProps('Electron')).includes('—'), 'no em dashes in the unlock card copy')
}

console.log('2) FDA on, meeting-heavy — schedule at F, people at I, locked artifacts gone')
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
  const plan = buildBoardPlan(fdaScan)
  ok(at(plan, 'schedule') && at(plan, 'schedule').x === -225 && at(plan, 'schedule').y === -15, 'schedule takes flex slot E')
  ok(at(plan, 'people') && at(plan, 'people').x === 240 && at(plan, 'people').y === 5, 'people takes flex slot F')
  ok(at(plan, 'workflows') && at(plan, 'workflows').x === UNLOCK_POS.x && at(plan, 'workflows').y === UNLOCK_POS.y, 'workflows takes slot I (free when FDA is on)')
  ok(at(plan, 'schedule').props.items.length === 3 && /\w{3} \d{2}:\d{2}/.test(at(plan, 'schedule').props.items[0].time), 'schedule items carry weekday+time')
  ok(at(plan, 'people').props.items[0].sub === 'texts with you', 'messages-joined person labeled by via')
  ok(at(plan, 'profile').props.facts.some((f) => f.k === 'Meetings'), 'profile gains a meetings fact')
  ok(at(plan, 'rhythm').props.topApps[0].secs === 7200, 'rhythm uses real focus time')
  ok(!at(plan, 'gaps').props.items.some((g) => g.q === 'The personal layer'), 'gaps drops the unlock teaser')
}

console.log('3) web-first life — workflows takes the HERO slot, projects yields')
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
        { host: 'canva.com', name: 'Canva', n: 90, color: '#00C4CC' }
      ]
    }
  }
  const plan = buildBoardPlan(webScan)
  const wf = at(plan, 'workflows')
  ok(wf && wf.x === -225 && wf.y === -390, 'workflows card is the hero')
  ok(wf.props.title === 'Where your work lives', 'hero workflows gets the web-first title')
  ok(wf.props.items.filter((i) => i.integration).length === 2, 'connectable integrations marked')
  ok(!at(plan, 'projects'), 'no projects card for a web-first life')
}

console.log('4) sparse scan — cards skip, board never crashes')
{
  const empty = {
    meta: { v: 2, generatedAt: 0, fda: false, spanDays: 1, nText: 0, nEvents: 0, fdaLocked: [] },
    identity: { name: null, computer: null, locale: {}, defaultBrowser: null },
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
  const plan = buildBoardPlan(empty)
  const roles = plan.map((c) => c.role)
  ok(roles.includes('profile') && roles.includes('gaps'), 'profile + gaps always render')
  ok(roles.length === 2, `everything else skips (got ${roles.join(',')})`)
  ok(at(plan, 'profile').props.name === 'Unknown subject', 'nameless scan degrades gracefully')
}

console.log('5) malformed scan sections — planner skips, never throws')
{
  const broken = JSON.parse(JSON.stringify(FIXTURE))
  broken.cadence = null
  broken.web = null
  let plan = null
  try {
    plan = buildBoardPlan(broken)
  } catch {
    /* must not throw */
  }
  ok(Array.isArray(plan), 'planner returns a plan despite broken sections')
  ok(plan && !at(plan, 'rhythm') && !at(plan, 'workflows'), 'broken cards are skipped')
  ok(plan && at(plan, 'projects'), 'healthy cards survive')
}

console.log('6) unlock card contract')
{
  const p = unlockCardProps('Electron')
  ok(p.state === 'locked' && p.appName === 'Electron' && Array.isArray(p.sources) && p.sources.length >= 4, 'unlock props complete')
  ok(UNLOCK_POS.w >= 300 && UNLOCK_POS.h >= 150, 'unlock position sane')
}

if (failed) {
  console.error(`\n✗ ${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ onboarding seed test passed')
