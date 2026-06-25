#!/usr/bin/env node
// scripts/oss-publish.mjs — publish a curated snapshot of the current branch to the public OSS repo.
//
// The OSS repo (github.com/blitzdotdev/blitzos-oss) is NOT a mirror of this private repo. Its `main` is a
// single ORPHAN snapshot with a hand-curated PUBLIC LAYER that does not exist on blitz-v1: the LICENSE
// (Apache-2.0) + OSS hygiene docs, plus sanitized README/CLAUDE/.gitignore/package.json. A naive
// "snapshot of blitz-v1" would DELETE that layer and LEAK the private README/CLAUDE — so this script:
//   1. takes the latest CODE from the current branch,
//   2. DROPS the internal-only paths (EXCLUDE),
//   3. PRESERVES the curated public layer by overlaying those files from the live OSS main (PRESERVE),
//   4. commits one orphan snapshot and (with --push) force-pushes it to OSS main.
//
//   node scripts/oss-publish.mjs            DRY RUN — build + scan + print the file list. Pushes NOTHING. (default)
//   node scripts/oss-publish.mjs --push     force-push the snapshot to OSS main (public, irreversible)
//
// The OSS release.yml triggers on a push to ANY branch, so pushing main builds + (if the Apple signing
// secrets are set on that repo) signs/notarizes the DMG.

import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'

const OSS_REMOTE = 'https://github.com/blitzdotdev/blitzos-oss.git'
const OSS_BRANCH = 'main'

// Internal-only paths NEVER published. Everything not listed (and not preserved below) ships from the branch.
const EXCLUDE = [
  'plans', // internal planning docs
  'issues', // internal issue tracker
  'lab', // experiments / spikes
  'preview', // server-mode backend (OSS is island-only) — judgment call
  'agent-os-workspaces.md', // internal design doc
  'doctrine-review.md', // generated internal review artifact
  'integrations.config.example.json', // example config — judgment call (.env.example DOES ship)
  'vite.renderer.preview.mjs', // server-preview build helper
  'scripts/oss-publish.mjs' // this tool itself
]

// The curated PUBLIC layer: take these from the LIVE OSS main, NOT from the branch. Two reasons a file is here:
//   (a) only-in-OSS — added for the public repo, absent from the branch (license, hygiene docs, fonts license,
//       the OSS test runner). A branch snapshot would delete them.
//   (b) sanitized — exists in both but the OSS copy is public-curated; the branch copy is private and would LEAK.
// NOTE: stale OSS-only CODE (e.g. the removed handoffStore.ts) is deliberately NOT here, so it is not resurrected.
const PRESERVE = [
  // (a) only-in-OSS hygiene / legal / packaging
  'LICENSE',
  'NOTICE',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'ARCHITECTURE.md',
  'THIRD-PARTY-NOTICES.md',
  '.env.example',
  '.nvmrc',
  'scripts/run-tests.mjs',
  'src/renderer/src/assets/fonts/OFL.txt',
  // (b) sanitized in both — keep the public version (the private ones leak internal content)
  'README.md',
  'CLAUDE.md',
  '.gitignore',
  'package.json' // OSS metadata (name/license/repo). CAVEAT: deps not auto-synced — see the dep-drift check below.
]

const TRIPWIRES = ['BEGIN [A-Z ]*PRIVATE KEY', 'ghp_[A-Za-z0-9]{30,}', 'github_pat_[A-Za-z0-9_]{30,}', 'sk-[A-Za-z0-9]{20,}', 'AKIA[0-9A-Z]{16}', 'xox[baprs]-[A-Za-z0-9-]{10,}']
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.icns', '.woff', '.woff2', '.ttf', '.otf', '.zip', '.gz', '.pdf', '.mp4', '.mov', '.node', '.wasm'])

const PUSH = process.argv.includes('--push')
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts })
const existsInRef = (work, ref, path) => {
  try {
    execSync(`git -C "${work}" cat-file -e "${ref}:${path}"`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function depDriftWarning(work) {
  // package.json comes from OSS (PRESERVE). If the branch added/changed deps, the OSS copy goes stale and the
  // build can break. Compare dependency maps and warn — this is the one file that needs occasional manual re-sync.
  try {
    const oss = JSON.parse(sh(`git -C "${work}" show "FETCH_HEAD:package.json"`))
    const branch = JSON.parse(readFileSync(join(work, '.branch-package.json'), 'utf8'))
    const flat = (p) => JSON.stringify({ d: p.dependencies || {}, dd: p.devDependencies || {} })
    if (flat(oss) !== flat(branch)) {
      console.warn('  ⚠ package.json DEPENDENCIES differ between the branch and the published (OSS) copy.')
      console.warn('    The OSS package.json is kept for its public metadata, so new branch deps are NOT carried over.')
      console.warn('    Re-sync deps into the OSS package.json before relying on this build.')
    } else {
      console.log('  ✓ package.json deps in sync with the branch')
    }
  } catch {
    /* best-effort */
  }
}

function secretScan(work) {
  let ranGitleaks = false
  try {
    execSync('command -v gitleaks', { stdio: 'ignore' })
    ranGitleaks = true
  } catch {
    ranGitleaks = false
  }
  if (ranGitleaks) {
    try {
      run(`gitleaks detect --no-git --redact --source "${work}"`)
      console.log('  ✓ gitleaks: clean')
    } catch {
      throw new Error('gitleaks flagged potential secrets (above). Aborting — fix before publishing.')
    }
  } else {
    console.warn('  ⚠ gitleaks not installed — falling back to a SHALLOW tripwire grep, not a full scan.')
    console.warn('    Install it for a real pre-publish scan:  brew install gitleaks')
  }
  const files = sh(`git -C "${work}" ls-files`).split('\n').filter(Boolean)
  const rx = new RegExp(TRIPWIRES.join('|'))
  const hits = []
  for (const f of files) {
    if (BINARY_EXT.has(extname(f).toLowerCase())) continue
    const abs = join(work, f)
    try {
      if (statSync(abs).size > 2_000_000) continue
      if (rx.test(readFileSync(abs, 'utf8'))) hits.push(f)
    } catch {
      /* skip */
    }
  }
  if (hits.length) throw new Error(`tripwire matched secret-like content in:\n  ${hits.join('\n  ')}\nAborting.`)
  console.log('  ✓ tripwire: no obvious private keys / tokens')
}

const repoRoot = sh('git rev-parse --show-toplevel')
const branch = sh('git rev-parse --abbrev-ref HEAD')
if (sh('git status --porcelain')) {
  console.warn(`\n⚠  "${branch}" has uncommitted changes. The snapshot is taken from the COMMITTED tip, so anything`)
  console.warn('   uncommitted will NOT be published. Commit first if you want it in this release.\n')
}

const tmp = mkdtempSync(join(tmpdir(), 'oss-publish-'))
const work = join(tmp, 'repo')
try {
  console.log(`• cloning "${branch}" (committed tip) → temp clone`)
  run(`git clone --quiet --branch "${branch}" --single-branch "${repoRoot}" "${work}"`)

  // keep a copy of the BRANCH package.json for the dep-drift check (before we overlay the OSS one)
  if (existsSync(join(work, 'package.json'))) run(`cp "${join(work, 'package.json')}" "${join(work, '.branch-package.json')}"`)

  console.log('• fetching the live OSS main (its curated public layer)')
  run(`git -C "${work}" fetch --quiet "${OSS_REMOTE}" ${OSS_BRANCH}`)

  // flatten to a single orphan snapshot of the branch tree
  run(`git -C "${work}" checkout --quiet --orphan ${OSS_BRANCH}`)

  // 1) drop internal-only paths
  const dropped = EXCLUDE.filter((p) => existsSync(join(work, p)))
  if (dropped.length) run(`git -C "${work}" rm -r --cached --quiet ${dropped.map((p) => `"${p}"`).join(' ')}`)

  // 2) overlay the curated public layer from the live OSS main (only files that exist there)
  const preserved = PRESERVE.filter((p) => existsInRef(work, 'FETCH_HEAD', p))
  for (const p of preserved) run(`git -C "${work}" checkout FETCH_HEAD -- "${p}"`)
  const missingPreserve = PRESERVE.filter((p) => !preserved.includes(p))

  run(`git -C "${work}" -c user.name="BlitzOS Release" -c user.email="release@blitz.dev" commit --quiet --allow-empty -m "BlitzOS — public snapshot ${new Date().toISOString().slice(0, 10)}"`)

  const files = sh(`git -C "${work}" ls-tree -r --name-only HEAD`).split('\n').filter(Boolean)
  console.log(`\n• snapshot: ${files.length} files`)
  console.log(`  ↳ excluded ${dropped.length} internal path(s): ${dropped.join(', ') || '(none present)'}`)
  console.log(`  ↳ preserved ${preserved.length} curated public file(s) from OSS main`)
  if (missingPreserve.length) console.warn(`  ⚠ PRESERVE entries not found on OSS main (check the list): ${missingPreserve.join(', ')}`)
  console.log(`  ↳ LICENSE present: ${files.includes('LICENSE') ? 'yes ✓' : 'NO ✗ (do not publish without it)'}`)

  console.log('\n• checks:')
  depDriftWarning(work)
  secretScan(work)

  if (!PUSH) {
    console.log('\n✓ DRY RUN complete — nothing pushed. Re-run with --push to publish to OSS main.')
  } else {
    console.log(`\n• force-pushing snapshot → ${OSS_REMOTE} (${OSS_BRANCH})`)
    run(`git -C "${work}" push "${OSS_REMOTE}" +${OSS_BRANCH}:${OSS_BRANCH}`)
    console.log('\n✓ Published. The OSS release.yml workflow will now build the DMG.')
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
