// The PURE half of the onboarding director (plans/onboarding-case-file.md P1): scan.json → a
// board plan (which template widgets, where, with what props). No Electron, no fs — so the seed
// test (scripts/test-onboarding-seed.mjs) runs it under plain node, and a future server-mode
// onboarding can bind the same plan to its own ops. onboarding.ts owns the impure half (the scan
// child, surface creation, FDA poll).
//
// ADAPTIVE SLOTS: fixed cards own their slot; the flex slots (B = hero, F, I) are assigned by
// what the scan found — a web-first life puts the Workflows card in the hero slot (projects
// yields), a meeting-heavy life gets the Schedule card, and when FDA is off the unlock card
// keeps slot I. Cards whose section is empty return null and simply don't exist. World coords:
// the primary area is centered on the origin, so the board hugs (0,0) and goToPrimary frames it.

// The grid must FIT the renderer's primary rect or creation clamps it into view and columns
// overlap (observed live at 1440×900: rect ≈ 1364×798, i.e. x∈[-682,682], y∈[-399,399]).
// 1320×780 fits the 14" default; smaller screens clamp gracefully (≤60px drift).
const SLOTS = {
  A: { x: -660, y: -390, w: 420, h: 260 }, // top-left — profile
  B: { x: -225, y: -390, w: 450, h: 360 }, // top-center HERO — projects, or workflows when web-first
  C: { x: 240, y: -390, w: 420, h: 380 }, // top-right — gaps
  D: { x: -660, y: -115, w: 420, h: 280 }, // left-mid — rhythm
  E: { x: -225, y: -15, w: 450, h: 220 }, // center — toolbox
  F: { x: 240, y: 5, w: 420, h: 190 }, // right-mid — flex
  G: { x: -660, y: 180, w: 420, h: 210 }, // left-bottom — voice
  H: { x: -225, y: 220, w: 450, h: 170 }, // center-bottom — sessions
  I: { x: 240, y: 210, w: 420, h: 180 } // right-bottom — flex; the unlock card's slot when FDA is off
}
export const UNLOCK_POS = SLOTS.I

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
const TITLE_OF = { profile: 'Case File', projects: 'Projects', workflows: 'Web workflows', schedule: 'Coming up', rhythm: 'Working rhythm', voice: 'In their own words', sessions: 'Recent sessions', people: 'Known associates', gaps: 'Open questions' }

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

/** scan.json → resolved, PLACED widget-card plan (spawn order = narrative order). */
export function buildBoardPlan(scan) {
  const props = {}
  for (const role of Object.keys(BUILDERS)) {
    try {
      props[role] = BUILDERS[role](scan)
    } catch {
      props[role] = null // a malformed scan section skips its card, never kills the board
    }
  }
  // Placement: fixed slots, then the flex slots by what the scan says this life looks like.
  const placement = { profile: 'A', gaps: 'C', rhythm: 'D', voice: 'G', sessions: 'H' }
  const placed = new Set(Object.keys(placement))
  const webFirst = !!(scan.web && scan.web.webFirst && props.workflows)
  const hero = webFirst ? 'workflows' : ['projects', 'workflows', 'schedule'].find((r) => props[r])
  if (hero) {
    placement[hero] = 'B'
    placed.add(hero)
  }
  const flexSlots = scan.meta.fda ? ['E', 'F', 'I'] : ['E', 'F'] // FDA off → the unlock card owns slot I
  for (const slot of flexSlots) {
    const next = ['schedule', 'people', 'workflows', 'projects'].find((r) => props[r] && !placed.has(r))
    if (!next) break
    placement[next] = slot
    placed.add(next)
  }
  const ORDER = ['profile', hero, 'rhythm', 'voice', 'sessions'].concat(flexSlots.map((sl) => Object.keys(placement).find((r) => placement[r] === sl))).concat(['gaps'])
  const plan = []
  const emitted = new Set()
  for (const role of ORDER) {
    if (!role || emitted.has(role) || !props[role] || !placement[role]) continue
    emitted.add(role)
    plan.push({ role, widget: WIDGET_OF[role], title: TITLE_OF[role], ...SLOTS[placement[role]], props: { ...props[role], ...(ACCENT_OF[role] || {}) } })
  }
  return plan
}
