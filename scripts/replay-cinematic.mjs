#!/usr/bin/env node
// Replay the cinematic intro animation in a running BlitzOS instance.
// Usage: node scripts/replay-cinematic.mjs
// Does NOT restart the app or touch TCC permissions.

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const SESSION_FILE = join(homedir(), '.blitzos', 'session.json')

let session
try {
  session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
} catch {
  console.error('BlitzOS is not running or session.json not found at', SESSION_FILE)
  process.exit(1)
}

const { url, token } = session.local ?? {}
if (!url || !token) {
  console.error('session.json has no local.url / local.token — app may not be running')
  process.exit(1)
}

try {
  const res = await fetch(`${url}/replay-cinematic`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.ok) {
    console.log('Cinematic triggered.')
  } else {
    const body = await res.text().catch(() => '')
    console.error(`HTTP ${res.status}:`, body)
    process.exit(1)
  }
} catch (err) {
  console.error('Could not reach BlitzOS control server:', err.message)
  process.exit(1)
}
