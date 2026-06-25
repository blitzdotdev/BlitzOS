// #53 — prove per-workspace consent persists to .blitzos/state/consent.json and is restored on boot
// (a fresh host on the same folder reads the prior grants), and is swapped per workspace.
import { writeConsent, readConsent } from '../../src/main/workspace.mjs'
import { createWorkspaceHost } from '../../src/main/workspace-host.mjs'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}

console.log('writeConsent / readConsent round-trip:')
{
  const d = mkdtempSync(join(tmpdir(), 'aos-consent-'))
  writeConsent(d, { surfaces: ['surf1:github', 'surf2:discord'], providers: ['gmail'] })
  ok('consent.json is written under .blitzos/state (agent-read-denied)', existsSync(join(d, '.blitzos', 'state', 'consent.json')))
  const c = readConsent(d)
  ok('surfaces round-trip', JSON.stringify(c.surfaces.sort()) === JSON.stringify(['surf1:github', 'surf2:discord']), c.surfaces)
  ok('providers round-trip', JSON.stringify(c.providers) === JSON.stringify(['gmail']), c.providers)
  ok('a folder with no consent.json reads empty (no throw)', JSON.stringify(readConsent(mkdtempSync(join(tmpdir(), 'aos-consent-')))) === JSON.stringify({ surfaces: [], providers: [] }))
  writeConsent(d, { surfaces: ['x'], providers: [] })
  ok('rewrite replaces (dedup, no append growth)', readConsent(d).surfaces.length === 1, readConsent(d).surfaces)
  rmSync(d, { recursive: true, force: true })
}

console.log('\nhost: persist on grant, RESTORE on boot (a fresh host reads the prior grants):')
{
  const root = mkdtempSync(join(tmpdir(), 'aos-consent-root-'))
  const adapter = () => ({ root, initialName: 'Home', getState: () => ({ surfaces: [] }), setState: () => {}, broadcast: () => {}, defaultMode: 'desktop' })
  const h1 = createWorkspaceHost(adapter())
  h1.persistConsent({ surfaces: ['note-1:github'], providers: ['github'] })
  ok('host.consent() reflects what was persisted', h1.consent().providers.includes('github') && h1.consent().surfaces.includes('note-1:github'), h1.consent())
  h1.stopWatch?.()
  // a fresh host on the SAME root (simulates a restart) must read the persisted consent for Home
  const h2 = createWorkspaceHost(adapter())
  const c = h2.consent()
  ok('a fresh host (restart) restores the persisted consent', c.providers.includes('github') && c.surfaces.includes('note-1:github'), c)
  h2.stopWatch?.()
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
