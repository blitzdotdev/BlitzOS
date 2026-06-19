// Visual-only mock data for the dynamic-island design prototypes (plans/island-proto-briefs.md). No backend:
// the protos render these so the design pass is about look + feel, not wiring. Shapes are the proto contract.
export type SessionStatus = 'working' | 'waiting' | 'idle' | 'done' | 'error'

export interface MockSession {
  id: string
  title: string
  subtitle: string
  status: SessionStatus
  glyph: string // a leading emoji/char stand-in for an agent avatar / SF Symbol
  accent: string // per-agent accent (used by the expressive proto's per-agent tinting)
}

export interface MockMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  ts: string // human label, e.g. "now", "2m"
}

export interface MockActivity {
  id: string
  kind: 'tool' | 'thought' | 'edit' | 'run' | 'done'
  label: string
  detail: string
  ts: string
  status: 'running' | 'done' | 'error'
}

export const MOCK_SESSIONS: MockSession[] = [
  { id: 's1', title: 'Refactor auth flow', subtitle: 'editing session.ts', status: 'working', glyph: '◆', accent: '#7DD3FC' },
  { id: 's2', title: 'Research notch designs', subtitle: 'waiting for input', status: 'waiting', glyph: '✦', accent: '#34C759' },
  { id: 's3', title: 'Fix flaky tests', subtitle: 'ran 3 tools', status: 'idle', glyph: '⬡', accent: '#D946EF' },
  { id: 's4', title: 'Draft launch email', subtitle: 'done · 4 edits', status: 'done', glyph: '✎', accent: '#FBBF24' }
]

export const MOCK_MESSAGES: Record<string, MockMessage[]> = {
  s1: [
    { id: 'm1', role: 'user', text: 'Refactor the auth flow to use the new session middleware.', ts: '5m' },
    { id: 'm2', role: 'agent', text: 'Mapping the call sites now. Found 7 usages across 3 files. Starting with session.ts.', ts: '4m' },
    { id: 'm3', role: 'agent', text: 'Replaced the legacy token check with requireSession(). Running the type check.', ts: 'now' }
  ],
  s2: [
    { id: 'm1', role: 'user', text: 'Look into how Apple does the dynamic island morph.', ts: '8m' },
    { id: 'm2', role: 'agent', text: 'I found the spring params and the four expanded regions. Want me to apply them to our notch?', ts: '1m' }
  ],
  s3: [
    { id: 'm1', role: 'user', text: 'The window-system test is flaky. Figure out why.', ts: '20m' },
    { id: 'm2', role: 'agent', text: 'It is a race on the off-screen view. I can add a deterministic wait. Confirm before I edit?', ts: '12m' }
  ],
  s4: [
    { id: 'm1', role: 'user', text: 'Draft the launch email for the notch feature.', ts: '1h' },
    { id: 'm2', role: 'agent', text: 'Done. Four passes, tightened the subject line. Ready for your review.', ts: '52m' }
  ]
}

// ── Connectors view (visual-only): the skills/connectors chips + the open-apps list with expandable tabs. ──────
export interface MockSkill {
  id: string
  name: string
}

export interface MockTab {
  id: string
  title: string
}

export interface MockApp {
  id: string
  name: string
  glyph: string // a leading char stand-in for the app icon
  tabs: MockTab[]
}

// Commonly used skills/connectors (Deep lives here now, it is just one of them).
export const MOCK_SKILLS: MockSkill[] = [
  { id: 'deep', name: 'Deep' },
  { id: 'memory', name: 'Memory' },
  { id: 'web', name: 'Web search' },
  { id: 'browser', name: 'Browser' },
  { id: 'vision', name: 'Vision' },
  { id: 'files', name: 'Files' },
  { id: 'shell', name: 'Shell' }
]

// Open apps, each expandable to its tabs/windows (Chrome → its tabs, etc).
export const MOCK_OPEN_APPS: MockApp[] = [
  {
    id: 'chrome',
    name: 'Chrome',
    glyph: '🌐',
    tabs: [
      { id: 'c1', title: 'GitHub · blitzdotdev/BlitzOS' },
      { id: 'c2', title: 'Gmail · Inbox (3)' },
      { id: 'c3', title: 'Notion · Launch plan' },
      { id: 'c4', title: 'Apple HIG · Dynamic Island' }
    ]
  },
  { id: 'figma', name: 'Figma', glyph: '✦', tabs: [{ id: 'f1', title: 'Island mockups' }, { id: 'f2', title: 'Design tokens' }] },
  { id: 'slack', name: 'Slack', glyph: '◈', tabs: [{ id: 'k1', title: '#blitzos' }, { id: 'k2', title: '#design' }] },
  { id: 'terminal', name: 'Terminal', glyph: '⌘', tabs: [{ id: 't1', title: 'agent-os · npm run dev' }] },
  { id: 'notes', name: 'Notes', glyph: '✎', tabs: [{ id: 'n1', title: 'Scratch' }] }
]

export const MOCK_ACTIVITY: Record<string, MockActivity[]> = {
  s1: [
    { id: 'a1', kind: 'tool', label: 'Grep', detail: 'requireSession across src/', ts: '4m', status: 'done' },
    { id: 'a2', kind: 'edit', label: 'Edit', detail: 'src/main/session.ts +18 −9', ts: '3m', status: 'done' },
    { id: 'a3', kind: 'run', label: 'Run', detail: 'npm run typecheck', ts: 'now', status: 'running' }
  ],
  s2: [
    { id: 'a1', kind: 'tool', label: 'WebSearch', detail: 'Apple Dynamic Island spec', ts: '6m', status: 'done' },
    { id: 'a2', kind: 'thought', label: 'Thinking', detail: 'Mapping regions to our panel', ts: '2m', status: 'done' },
    { id: 'a3', kind: 'thought', label: 'Waiting', detail: 'needs your go-ahead', ts: '1m', status: 'running' }
  ],
  s3: [
    { id: 'a1', kind: 'run', label: 'Run', detail: 'test-window-system.ts (x5)', ts: '15m', status: 'done' },
    { id: 'a2', kind: 'thought', label: 'Found', detail: 'race on off-screen view', ts: '12m', status: 'done' }
  ],
  s4: [
    { id: 'a1', kind: 'edit', label: 'Draft', detail: 'launch-email.md', ts: '58m', status: 'done' },
    { id: 'a2', kind: 'done', label: 'Done', detail: '4 revisions', ts: '52m', status: 'done' }
  ]
}
