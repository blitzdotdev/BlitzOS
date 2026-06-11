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
import { latticeFor, findSlot, sizePx } from '../renderer/src/stage-core.mjs'
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
  profile: (s) => ({
    title: 'Case File',
    kicker: 'BlitzOS · case file',
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
      .slice(0, 4),
    note: 'Compiled from a local, read-only scan of this Mac. Nothing left the machine. This board is the OS’s working model of you: edit it and it learns.'
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
    return {
      title: s.web.webFirst ? 'Where your work lives' : 'Web workflows',
      items,
      note: s.web.webFirst
        ? 'Most of your life is in the browser. Open any of these as a live surface here; the OS can connect the marked ones and act in them with you.'
        : 'Your web tools. Open any as a live surface here.'
    }
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
      heatLo: '#7FA0C8', // dusty blue → coral: quiet hours cool, intense hours warm (never monochrome)
      heatHi: '#FF8D61',
      ...(s.meta.fda ? {} : { note: 'launch counts only; real focus time is locked' })
    }
  },
  voice: (s) =>
    s.voice.length
      ? { title: 'In their own words', items: s.voice.slice(0, 4).map((v) => ({ text: v.text, source: v.source })), note: 'verbatim, found locally. This is how the OS will learn to write as you.' }
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
      ...(s.meta.fda ? [] : [{ q: 'The personal layer', hint: 'Messages cadence, Mail, Calendar, Safari and real screen time, locked until Full Disk Access' }])
    ],
    note: 'what the OS cannot learn by looking. The interview starts here.'
  })
}

const WIDGET_OF = { profile: 'profile', projects: 'dossiers', workflows: 'workflows', schedule: 'timeline', rhythm: 'rhythm', voice: 'quotes', sessions: 'timeline', people: 'dossiers', gaps: 'gaps' }
const TITLE_OF = { profile: 'Case File', projects: 'Projects', workflows: 'Web workflows', schedule: 'Coming up', rhythm: 'Working rhythm', voice: 'In their own words', sessions: 'Recent sessions', people: 'Known associates', gaps: 'Open questions', unlock: 'Unlock the personal layer' }

// Every card samples its accent from the Blitz paper palette (design-system §3) — varied across
// the board, stable per role. The UI kit applies props.accent/accentInk to --blitz-accent.
const ACCENT_OF = {
  profile: { accent: '#FF8D61', accentInk: '#2B1100' }, // signature coral
  projects: { accent: '#5B78AA', accentInk: '#FFFFFF' }, // slate
  workflows: { accent: '#924B2F', accentInk: '#FFFFFF' }, // terracotta
  schedule: { accent: '#7FA0C8', accentInk: '#16202F' }, // dusty blue
  rhythm: { accent: '#FF8D61', accentInk: '#2B1100' }, // coral (heat ramp supplies the rest)
  voice: { accent: '#493839', accentInk: '#FFFFFF' }, // mauve
  sessions: { accent: '#7FA0C8', accentInk: '#16202F' }, // dusty blue
  people: { accent: '#7FA98C', accentInk: '#11211A' }, // sage
  gaps: { accent: '#E8C71D', accentInk: '#2A2400' } // marker — highlighter over the unknowns
}

// ---- slot sizing: the right span for the card's CONTENT, not a fixed grid ----
// profile is the centerpiece and breathes (l). The dossier grid needs columns (xl: 4 wide).
// The punchcard needs 24 cells of width (l minimum). List cards scale with their item count:
// a 2-item list is a wide strip (m), a long one is portrait (tall) or big (l).
const count = (p) => ((p && p.items) || []).length
const SIZE_FOR = {
  profile: () => 'l',
  projects: () => 'xl',
  workflows: (p) => (count(p) >= 6 ? 'tall' : 'l'),
  schedule: (p) => (count(p) >= 5 ? 'l' : 'm'),
  rhythm: () => 'l',
  people: (p) => (count(p) >= 4 ? 'l' : 'm'),
  voice: (p) => (count(p) >= 3 ? 'l' : 'm'),
  sessions: () => 'm',
  gaps: (p) => (count(p) >= 4 ? 'l' : 'm'),
  unlock: () => 'l'
}
// When the preferred span doesn't fit, shrink one step at a time. m is the content floor
// (no board card reads at s = 164px); below that the card parks off-stage instead.
const SHRINK = { xxl: 'xl', xl: 'l', tall: 'l', l: 'm', m: null }
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

/** Off-stage parking spot below the stage frame (mirrors the os-tools parkOffstage cascade). */
function parkSpot(vp, i) {
  const r = stageRect(0, vp)
  return { x: Math.round(r.x + 60 + (i % 8) * 64), y: Math.round(r.y + r.h + 100 + (i % 8) * 48) }
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
export function buildBoardPlan(scan, { surfaces = [], viewport = null } = {}) {
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
    let size = SIZE_FOR[role] ? SIZE_FOR[role](props[role]) : 'm'
    let at = null
    while (size) {
      at = findSlot(occupied, lat, size, NEAR_OF[role] || 'center', 0)
      if (at) break
      size = SHRINK[size]
    }
    if (at) {
      card.slot = { col: at.col, row: at.row, size }
      card.slotStage = 0
      occupied.push({ id: 'plan:' + role, slot: card.slot, slotStage: 0 })
    } else {
      // lattice full: park below the stage, alive and zoom-out visible — never overlap a tile
      const px = sizePx(SIZE_FOR[role] ? SIZE_FOR[role](props[role]) : 'm')
      Object.assign(card, { offstage: true, ...parkSpot(vp, parked), w: px.w, h: px.h })
      parked++
    }
    plan.push(card)
  }
  return plan
}
