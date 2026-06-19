// node scripts/build-extension.mjs
// Pack the BlitzOS Connector extension into a signed .crx for the self-hosted force-install. Uses Google
// Chrome's --pack-extension (signed with extension/key.pem — the gitignored signing key whose public half is
// the manifest `key`, so the extension id is stable). Output: <repo>/extension.crx. Dev uses load-unpacked
// and never needs this; it's for the force-install path (connection-install.ts serves the .crx on localhost).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, cpSync, rmSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const extDir = join(root, 'extension')
const key = join(extDir, 'key.pem')
const crx = join(root, 'extension.crx')

if (!existsSync(join(extDir, 'manifest.json'))) {
  console.error('no extension/ source found')
  process.exit(1)
}
if (!existsSync(key)) {
  console.error('missing extension/key.pem (the signing key). Generate it once with:')
  console.error('  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out extension/key.pem')
  process.exit(1)
}

const chromes = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', process.env.CHROME_BIN].filter(Boolean)
const chrome = chromes.find((c) => existsSync(c))
if (!chrome) {
  console.error('Google Chrome (or Chromium) not found — needed to pack the .crx. Set CHROME_BIN to its binary.')
  process.exit(1)
}

// Chrome REFUSES to pack a directory that contains the signing key, so pack a copy WITHOUT key.pem (or any
// stale .crx). The key is passed separately via --pack-extension-key (it stays at extension/key.pem).
const tmp = mkdtempSync(join(tmpdir(), 'blitz-ext-'))
const pkgDir = join(tmp, 'extension')
cpSync(extDir, pkgDir, { recursive: true, filter: (src) => !src.endsWith('key.pem') && !src.endsWith('.crx') })

try {
  // Chrome writes `<pkgDir>.crx` (i.e. <tmp>/extension.crx) + exits; it can return non-zero even on success.
  execFileSync(chrome, [`--pack-extension=${pkgDir}`, `--pack-extension-key=${key}`, '--no-message-box'], { stdio: 'inherit' })
} catch {
  /* check the artifact below rather than trusting the exit code */
}

const built = join(tmp, 'extension.crx')
if (existsSync(built)) {
  renameSync(built, crx)
  rmSync(tmp, { recursive: true, force: true })
  console.log('✓ packed', crx)
} else {
  rmSync(tmp, { recursive: true, force: true })
  console.error('✗ pack failed — no extension.crx produced')
  process.exit(1)
}
