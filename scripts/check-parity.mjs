// Parity guard — fails (exit 1) if the Electron and server runtimes stop sharing the
// ONE runtime core, so the recurring Electron↔server divergence can't silently return.
//
// The whole design: every piece of runtime logic lives in a shared src/main/*.mjs module,
// and Electron (src/main/*.ts) + the server (preview/backend.mjs) are thin adapters over it.
// This test encodes that invariant. It is intentionally static (greps imports + forbidden
// re-implementations) so it runs anywhere with no build. Run: `node scripts/check-parity.mjs`
// or `npm run parity`. Wire it into CI / a pre-commit gate so a 6th divergence trips it.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => { try { return readFileSync(join(ROOT, p), 'utf8') } catch { return '' } }
const SERVER = 'preview/backend.mjs'

// Every src/main source file (the Electron runtime), excluding type decls.
const MAIN_FILES = readdirSync(join(ROOT, 'src/main'))
  .filter((f) => (f.endsWith('.ts') || f.endsWith('.mjs')) && !f.endsWith('.d.ts') && !f.endsWith('.d.mts'))
const mainText = Object.fromEntries(MAIN_FILES.map((f) => [f, read(join('src/main', f))]))
const serverText = read(SERVER)

// Does a file's text import the shared core `<base>` (matches `…/<base>` or `…/<base>.mjs`)?
const importsCore = (text, base) =>
  new RegExp(`from\\s+['"][^'"]*\\/${base.replace(/[-/]/g, (c) => '\\' + c)}(?:\\.mjs)?['"]`).test(text)

// The shared runtime cores. Each MUST be imported by the server AND by ≥1 Electron file —
// neither transport may re-implement them. (Adding a new shared core? Add it here.)
const SHARED_CORES = [
  'os-tools',        // the one tool registry (makeOsTools)
  'relay',           // agent-socket relay lifecycle (startRelay + self-heal)
  'activity',        // the "Agent activity" feed (withActivity)
  'perception-core', // moments / sensors / /events
  'agent-runtime',   // an agent = a claude in a tmux terminal (bootstrap + claude command + --resume id)
  'workspace-host',  // folder-backed workspace host
  'control-core',    // CDP control vocabulary
  'widget-tools',    // sandboxed-widget tool/props bridge
  'terminal-ops',    // multi-terminal lifecycle (tmux-backed, workspace-keyed)
  'action-items'     // the human Action-items inbox (request_action / resolve, workspace-keyed)
]

const violations = []

// RULE 1 — each shared core imported by BOTH transports.
for (const core of SHARED_CORES) {
  const onServer = importsCore(serverText, core)
  const electronUsers = MAIN_FILES.filter((f) => f !== `${core}.mjs` && importsCore(mainText[f], core))
  if (!onServer) violations.push(`shared core "${core}" is NOT imported by the server (${SERVER}) — it must use the shared module, not re-implement it`)
  if (!electronUsers.length) violations.push(`shared core "${core}" is NOT imported by any Electron src/main file — it must use the shared module`)
}

// RULE 2 — the agent-socket SDK has ONE owner (relay.mjs). No transport may connect() directly;
// they go through startRelay so the connect/self-heal/watchdog can never diverge again.
const SDK = '@agent-socket/sdk'
const sdkImporters = [
  ...MAIN_FILES.filter((f) => mainText[f].includes(`from '${SDK}'`) || mainText[f].includes(`from "${SDK}"`)),
  ...(serverText.includes(`'${SDK}'`) || serverText.includes(`"${SDK}"`) ? [SERVER] : [])
].filter((f) => f !== 'relay.mjs')
if (sdkImporters.length) violations.push(`${SDK} must be imported ONLY by relay.mjs (single owner), but also by: ${sdkImporters.join(', ')} — route them through startRelay`)

// RULE 3 — the server must not re-define logic that belongs to a shared core (the exact drift
// we keep killing: activity feed re-inlined into backend.mjs).
const REIMPL = [
  { re: /function\s+withActivity\b|const\s+withActivity\s*=/, why: 'activity feed — import withActivity from activity.mjs' },
  { re: /function\s+activityText\b/, why: 'activity labels — import activityText from activity.mjs' },
  { re: /const\s+ACTIVITY_TOOLS\s*=/, why: 'activity tool set — import ACTIVITY_TOOLS from activity.mjs' }
]
for (const { re, why } of REIMPL) {
  if (re.test(serverText)) violations.push(`${SERVER} re-implements shared logic (${re}); ${why}`)
}

// Report.
if (violations.length) {
  console.error(`\n✗ PARITY VIOLATIONS (${violations.length}) — Electron↔server divergence detected:\n`)
  for (const v of violations) console.error('  • ' + v)
  console.error('\nFix: move the logic into a shared src/main/*.mjs core and import it from BOTH transports.\n')
  process.exit(1)
}
console.log(`✓ parity OK — ${SHARED_CORES.length} shared cores imported by both transports; no re-implementation; ${SDK} single-owner (relay.mjs).`)
