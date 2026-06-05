import { writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Single writer for ~/.blitzos/session.json so a local agent can discover BOTH:
//   - the relay (remote agents, subject to DO flakiness)
//   - the localhost control server (local agents — direct, reliable)
// agentSocket sets the relay; control-server sets the local URL+token.

interface SessionState {
  app: 'BlitzOS'
  url?: string // relay agents.md URL
  base?: string // relay tool base
  local?: { url: string; token: string } // localhost control server
}

const state: SessionState = { app: 'BlitzOS' }

function write(): void {
  try {
    const dir = join(homedir(), '.blitzos')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'session.json'),
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)
    )
  } catch (e) {
    console.error('[blitzos] session file write failed:', e instanceof Error ? e.message : e)
  }
}

export function setRelay(url: string): void {
  state.url = url
  state.base = url.replace(/\/agents\.md$/, '')
  write()
}

export function setLocal(url: string, token: string): void {
  state.local = { url, token }
  write()
}
