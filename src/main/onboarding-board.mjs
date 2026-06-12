// The PURE half of the onboarding director (plans/onboarding-case-file.md P1): scan.json → a
// board plan (which template widgets, at what SLOT SIZE, with what props). No Electron, no fs —
// so the seed test (scripts/test-onboarding-seed.mjs) runs it under plain node, and a future
// server-mode onboarding can bind the same plan to its own ops. onboarding.ts owns the impure
// half (the scan child, surface creation, FDA poll).
//
// STAGE LATTICE (plans/blitzos-stage-slot-desktop.md): the board is placed on the same slot grid
// the agents use — sizes are chosen PER CARD FROM ITS CONTENT (a punchcard needs width → l; a
// dossier grid is the hero → xl; 8 workflow rows are list-shaped → tall), then findSlot picks the
// exact free span against the LIVE surfaces (the pinned chat hub already holds a tall span). A
// card that can't fit shrinks one size at a time down to m; if the lattice is genuinely full it
// PARKS off-stage below the stage frame (alive, zoom-out visible, bring_to_stage-able) — tiles
// never overlap and never reflow, so there is no pixel math and no clamp dance to fight.
// Composition is steered with `near` hints, not coordinates; webFirst puts Workflows first in
// line for the prime spans (projects yields). The onboarding board deliberately saturates the
// stage past the agents' soft STAGE_BUDGET (it IS the user's first desktop); the hard cap is the
// lattice itself, and the resident brain is expected to curate it down from there.
import { latticeFor, findSlot, sizePx, spanOf } from '../renderer/src/stage-core.mjs'
import { stageRect, DEFAULT_VP } from '../renderer/src/stages-core.mjs'

const fmtHour = (h) => `${String(h).padStart(2, '0')}:00`
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const rel = (ts, now = Date.now()) => {
  if (!ts) return ''
  const d = Math.round((now - ts) / 86_400_000)
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d}d ago` : `${Math.round(d / 30)}mo ago`
}
const browserName = (b) => {
  if (!b) return null
  const last = b.split('.').pop() || b
  return last.charAt(0).toUpperCase() + last.slice(1)
}
// How we know a person → the card's subtitle + stat label.
const VIA_SUB = { commits: 'git collaborator', messages: 'texts with you', mail: 'emails you', meetings: 'meets with you', documents: 'co-author' }
const VIA_STAT = { commits: 'Commits', messages: 'Messages', mail: 'Emails', meetings: 'Meetings', documents: 'Docs' }

// ---- card builders (role → props | null). Placement is resolved separately. ----
const BUILDERS = {
  // Widget language: no prose on cards — notes are gone; identity is a tiny label + the content.
  profile: (s) => ({
    title: 'Case File',
    kicker: 'Case file',
    name: s.identity.name || 'Unknown subject',
    sub: [s.identity.computer, `${s.meta.spanDays} days of evidence`, `${(s.meta.nText + s.meta.nEvents).toLocaleString()} signals`].filter(Boolean).join(' · '),
    facts: [
      s.cadence.peakHours.length ? { k: 'Peak hours', v: s.cadence.peakHours.map(fmtHour).join(' · ') } : null,
      s.projects[0] ? { k: 'Top project', v: s.projects[0].name } : null,
      s.calendar && s.calendar.meetingsPerWeek > 0 ? { k: 'Meetings', v: `~${s.calendar.meetingsPerWeek}/wk` } : null,
      browserName(s.identity.defaultBrowser) ? { k: 'Browser', v: browserName(s.identity.defaultBrowser) } : null,
      { k: 'Apps', v: String(s.facts.installedApps) }
    ]
      .filter(Boolean)
      .slice(0, 4)
  }),
  projects: (s) => {
    const max = Math.max(...s.projects.map((p) => p.prompts), 1)
    const items = s.projects
      .slice(0, 8)
      .map((p) => ({ name: p.name, sub: 'agent sessions', score: Math.round((100 * p.prompts) / max), stats: [{ k: 'Prompts', n: p.prompts.toLocaleString() }] }))
    const seen = new Set(s.projects.slice(0, 8).map((p) => p.name))
    for (const r of s.repos) {
      if (items.length >= 12) break
      if (!seen.has(r)) {
        seen.add(r)
        items.push({ name: r, sub: 'repo on disk' })
      }
    }
    return items.length ? { title: 'Projects', items } : null
  },
  workflows: (s) => {
    const items = ((s.web && s.web.workflow) || []).map((w) => ({ name: w.name, host: w.host, n: w.n, ...(w.color ? { color: w.color } : {}), ...(w.integration ? { integration: w.integration } : {}) }))
    if (items.length < 3) return null
    return { title: s.web.webFirst ? 'Where your work lives' : 'Web workflows', items }
  },
  schedule: (s) => {
    const up = (s.calendar && s.calendar.upcoming) || []
    if (up.length < 2) return null
    return {
      title: 'Coming up',
      items: up.slice(0, 7).map((e) => {
        const d = new Date(e.start)
        return { time: e.allDay ? WD[d.getDay()] : `${WD[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, title: e.title, detail: e.attendees ? 'with others' : '' }
      })
    }
  },
  rhythm: (s) => {
    const hasPunch = Object.keys(s.cadence.punch || {}).length > 0
    const apps = s.cadence.topApps.length ? s.cadence.topApps : s.cadence.appLaunches
    if (!hasPunch && !apps.length) return null
    return {
      title: 'Working rhythm',
      punch: s.cadence.punch,
      peakHours: s.cadence.peakHours,
      activeWeekdays: s.cadence.activeWeekdays,
      topApps: apps,
      heatLo: '#7FA0C8', // dusty blue to hot red (picked 2026-06-11): quiet hours cool, intense hours warm (never monochrome)
      heatHi: '#f4360b',
      ...(s.meta.fda ? {} : { note: 'launch counts only' })
    }
  },
  voice: (s) =>
    s.voice.length
      ? { title: 'In their own words', items: s.voice.slice(0, 4).map((v) => ({ text: v.text, source: v.source })) }
      : null,
  sessions: (s) =>
    s.sessions.length
      ? { title: 'Recent sessions', items: s.sessions.slice(0, 7).map((x) => ({ time: rel(x.last), title: x.title, detail: x.project || x.agent })) }
      : null,
  people: (s) => {
    const named = s.people.filter((p) => p.kind === 'name').slice(0, 6)
    if (named.length < 2) return null
    const max = Math.max(...named.map((p) => p.n), 1)
    return {
      title: 'Known associates',
      items: named.map((p) => ({
        name: p.label,
        sub: VIA_SUB[p.via] || 'in your orbit',
        score: Math.round((100 * p.n) / max),
        stats: [{ k: VIA_STAT[p.via] || 'Signals', n: String(p.n) }]
      }))
    }
  },
  gaps: (s) => ({
    title: 'Open questions',
    items: [
      ...s.gaps.map((q) => ({ q })),
      ...(s.meta.fda ? [] : [{ q: 'The personal layer', hint: 'Messages, Mail, Calendar, Safari and screen time, locked until Full Disk Access' }])
    ]
  })
}

// The hand-tuned Branch A board (FDA granted), captured from the user's case-file layout 2026-06-12:
// the chat hub fills the left as an xxl tile, the cards run down columns 4-6. The seed reproduces this
// EXACTLY (a fixed slot per role) rather than auto-placing, because the user has decided the layout.
// `chat` is applied to the chat hub by the director (it is not a planner card). A card whose fixed slot
// would fall outside the LIVE lattice (a smaller screen) falls back to dynamic placement.
export const BRANCH_A_LAYOUT = {
  chat: { col: 0, row: 0, size: 'xxl' },
  projects: { col: 4, row: 0, size: 'm' },
  profile: { col: 6, row: 0, size: 's' },
  rhythm: { col: 4, row: 1, size: 'm' },
  workflows: { col: 6, row: 1, size: 's' },
  voice: { col: 4, row: 2, size: 'm' },
  gaps: { col: 6, row: 2, size: 's' },
  people: { col: 4, row: 3, size: 's' },
  sessions: { col: 5, row: 3, size: 's' },
  notepad: { col: 6, row: 3, size: 's' }
}

const WIDGET_OF = { profile: 'profile', projects: 'dossiers', workflows: 'workflows', schedule: 'timeline', rhythm: 'rhythm', voice: 'quotes', sessions: 'timeline', people: 'dossiers', gaps: 'gaps' }
const TITLE_OF = { profile: 'Case File', projects: 'Projects', workflows: 'Web workflows', schedule: 'Coming up', rhythm: 'Working rhythm', voice: 'In their own words', sessions: 'Recent sessions', people: 'Known associates', gaps: 'Open questions', unlock: 'Unlock the personal layer' }

// Card accents rotate through the four picked theme colors (2026-06-11: slate, dusty blue, sage,
// marker), varied across the board, stable per role. The UI kit applies props.accent/accentInk
// to --blitz-accent. Heat ramp is #7FA0C8 to #f4360b (see heatLo/heatHi above).
const ACCENT_OF = {
  profile: { accent: '#5B78AA', accentInk: '#FFFFFF' }, // slate
  projects: { accent: '#7FA0C8', accentInk: '#16202F' }, // dusty blue
  workflows: { accent: '#7FA98C', accentInk: '#11211A' }, // sage
  schedule: { accent: '#5B78AA', accentInk: '#FFFFFF' }, // slate
  rhythm: { accent: '#7FA0C8', accentInk: '#16202F' }, // dusty blue (heat ramp supplies the rest)
  voice: { accent: '#7FA98C', accentInk: '#11211A' }, // sage
  sessions: { accent: '#5B78AA', accentInk: '#FFFFFF' }, // slate
  people: { accent: '#7FA98C', accentInk: '#11211A' }, // sage
  gaps: { accent: '#E8C71D', accentInk: '#2A2400' } // marker, highlighter over the unknowns
}

// ---- slot sizing: FIT-FIRST, then grow into leftover space ----
// Every widget is responsive (gist at m, detail at bigger spans / popped out), so the planner's
// job is to get EVERY card on the stage first: all cards start compact (m; the unlock card l —
// its consent copy needs the height), and only then are upgrades granted in priority order while
// free cells remain. This is the inverse of "ideal size then overflow": clutter never beats fit.
const count = (p) => ((p && p.items) || []).length
const COMPACT = { unlock: 'l' } // everything else starts at m
// Upgrade wishlist, in priority order. Each is granted only if the card's content earns it AND
// the lattice still has the cells. cost = added cells over the current size.
const GROWS = [
  { role: 'projects', to: 'xl', want: (p) => count(p) >= 3 },
  { role: 'profile', to: 'l', want: () => true },
  { role: 'rhythm', to: 'l', want: (p) => Object.keys((p && p.punch) || {}).length > 12 },
  { role: 'workflows', to: 'tall', want: (p) => count(p) >= 6 },
  { role: 'workflows', to: 'l', want: (p) => count(p) >= 4 },
  { role: 'people', to: 'l', want: (p) => count(p) >= 4 },
  { role: 'voice', to: 'l', want: (p) => count(p) >= 3 },
  { role: 'schedule', to: 'l', want: (p) => count(p) >= 5 },
  { role: 'gaps', to: 'l', want: (p) => count(p) >= 4 }
]
const cellsOf = (size) => {
  const sp = spanOf(size)
  return sp.c * sp.r
}
// When even the chosen span doesn't fit the fragmented lattice, shrink one step at a time, down
// to s (every widget renders a gist at s, and s tiles soak up the 1-wide orphan column a 7-col
// lattice strands). The unlock card floors at m (its consent copy needs the room). Below the
// floor, the card goes BACKSTAGE.
const SHRINK = { xxl: 'xl', xl: 'l', tall: 'l', l: 'm', m: 's', s: null }
const FLOOR = { unlock: 'm' }
const shrinkFrom = (role, size) => {
  const next = SHRINK[size]
  if (!next) return null
  if (FLOOR[role] && size === FLOOR[role]) return null
  return next
}
// Composition hints (findSlot's near ranking) — shape without coordinates.
const NEAR_OF = {
  profile: 'top-left',
  projects: 'top-left',
  workflows: 'top-right',
  schedule: 'center',
  rhythm: 'bottom-left',
  people: 'center',
  voice: 'bottom-left',
  sessions: 'bottom-right',
  gaps: 'top-right',
  unlock: 'top-right'
}

export const UNLOCK_SIZE = 'l'

export function unlockCardProps(appName) {
  return {
    state: 'locked',
    appName,
    sources: [
      'Messages cadence and who you talk to',
      'Mail correspondents and topics',
      'Calendar, schedule and meetings',
      'Safari browsing history',
      'Real app focus time (Screen Time)',
      'Contacts, Notes and accounts'
    ]
  }
}

/** A free span for the unlock card against LIVE surfaces (the cached-board re-ensure path).
 *  Shrinks l→m; null when the stage is truly full (caller parks it). */
export function findUnlockSlot(surfaces, viewport = null) {
  const lat = latticeFor(viewport || DEFAULT_VP, 0)
  for (let size = UNLOCK_SIZE; size; size = SHRINK[size]) {
    const at = findSlot(surfaces || [], lat, size, NEAR_OF.unlock, 0)
    if (at) return { slot: { col: at.col, row: at.row, size }, slotStage: 0 }
  }
  return null
}

/** Off-stage parking below the stage frame: a clean GRID spaced by the card's own footprint —
 *  parked cards must never overlap each other (the cascade-by-64px pile read as clutter). */
function parkSpot(vp, i) {
  const r = stageRect(0, vp)
  const cell = sizePx('m')
  const col = i % 3
  const row = Math.floor(i / 3)
  return { x: Math.round(r.x + 40 + col * (cell.w + 24)), y: Math.round(r.y + r.h + 140 + row * (cell.h + 24)) }
}

/**
 * scan.json → resolved, PLACED card plan. Spawn order = priority order (what wins the prime
 * spans, and the assembly the human watches). Pass the LIVE surfaces so occupancy includes the
 * pinned chat hub and anything else already on stage 0.
 * Returns cards as either { slot:{col,row,size}, slotStage:0 } (staged tiles) or
 * { offstage:true, x, y, w, h } (parked below the stage, brain can bring_to_stage later).
 * The unlock card is part of the plan when FDA is off (role 'unlock', native) so it gets
 * placement priority right after the gaps card — the director merges appName into its props.
 */
/** A fixed slot fits the LIVE lattice (a smaller screen may not hold a col-6 card). */
function slotFits(slot, lat) {
  if (!slot) return false
  const sp = spanOf(slot.size)
  return slot.col >= 0 && slot.row >= 0 && slot.col + sp.c <= lat.cols && slot.row + sp.r <= lat.rows
}

export function buildBoardPlan(scan, { surfaces = [], viewport = null, layout = null } = {}) {
  const props = {}
  for (const role of Object.keys(BUILDERS)) {
    try {
      props[role] = BUILDERS[role](scan)
    } catch {
      props[role] = null // a malformed scan section skips its card, never kills the board
    }
  }
  const webFirst = !!(scan.web && scan.web.webFirst && props.workflows)
  const hero = webFirst ? 'workflows' : ['projects', 'workflows', 'schedule'].find((r) => props[r])
  const fdaOff = !(scan.meta && scan.meta.fda)
  if (fdaOff) props.unlock = {} // placement reservation; the director supplies the real props
  const ORDER = ['profile', hero, 'rhythm', 'gaps', ...(fdaOff ? ['unlock'] : []), 'workflows', 'people', 'schedule', 'voice', 'sessions', 'projects']

  const vp = viewport || DEFAULT_VP
  const lat = latticeFor(vp, 0)
  const occupied = [...(surfaces || [])] // live tiles (chat hub) + cards as we place them

  // Fit-first sizing: count the lattice cells already taken (the chat hub's span included), start
  // every present card compact, then grant upgrades in priority order while free cells remain.
  const present = ORDER.filter((r, i) => r && ORDER.indexOf(r) === i && props[r])
  let usedCells = 0
  for (const s of occupied) {
    const sl = s && s.slot
    if (sl && (s.slotStage ?? 0) === 0 && !s.minimized && !s.groupId) usedCells += cellsOf(sl.size)
  }
  const sizes = {}
  for (const r of present) {
    sizes[r] = COMPACT[r] || 'm'
    usedCells += cellsOf(sizes[r])
  }
  let free = lat.cols * lat.rows - usedCells
  for (const g of GROWS) {
    if (!present.includes(g.role) || !g.want(props[g.role])) continue
    const cost = cellsOf(g.to) - cellsOf(sizes[g.role])
    if (cost <= 0 || cost > free) continue
    sizes[g.role] = g.to
    free -= cost
  }

  const plan = []
  const emitted = new Set()
  let parked = 0
  for (const role of ORDER) {
    if (!role || emitted.has(role) || !props[role]) continue
    emitted.add(role)
    const card = {
      role,
      ...(role === 'unlock' ? { native: 'unlock' } : { widget: WIDGET_OF[role] }),
      title: TITLE_OF[role],
      props: { ...props[role], ...(ACCENT_OF[role] || {}) }
    }
    // Fixed layout (Branch A): place at the hand-tuned slot when it fits the live lattice; otherwise
    // fall through to dynamic placement (smaller screen, or a card the layout does not pin).
    const fixed = layout && layout[role]
    let at = fixed && slotFits(fixed, lat) ? { col: fixed.col, row: fixed.row } : null
    let size = at ? fixed.size : sizes[role] || 'm'
    while (!at && size) {
      at = findSlot(occupied, lat, size, NEAR_OF[role] || 'center', 0)
      if (at) break
      size = shrinkFrom(role, size) // fragmentation: step down (to the role's floor) before giving up
    }
    if (at) {
      card.slot = { col: at.col, row: at.row, size }
      card.slotStage = 0
      occupied.push({ id: 'plan:' + role, slot: card.slot, slotStage: 0 })
    } else {
      // truly no span left: BACKSTAGE — parked on the canvas below the stage frame, alive and
      // zoom-out visible, never overlapping a tile; the brain can bring_to_stage it later
      const px = sizePx('m')
      Object.assign(card, { offstage: true, ...parkSpot(vp, parked), w: px.w, h: px.h })
      parked++
    }
    plan.push(card)
  }
  return plan
}
