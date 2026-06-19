// Mock data for the dynamic island. Agent sessions/transcripts/status are now REAL (NotchHost pulls them from the
// chat channel), so only the connectors view is still mock: the skills/connectors chips + the open-apps list with
// expandable tabs (wiring real apps/tabs/files is a later step).
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
