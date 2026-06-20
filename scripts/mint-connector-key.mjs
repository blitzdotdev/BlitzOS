// node scripts/mint-connector-key.mjs
// Mint a fresh signing key for the BlitzOS Connector extension and sync the extension identity everywhere it is
// hard-referenced, so the force-install .crx, the Origin check, and the force-install policy all agree.
//
// WHEN to run this: only when the canonical extension/key.pem (the team's shared signing secret) is NOT on this
// machine and you need the force-install path working. It ROTATES the extension id for everyone — afterwards the
// new extension/key.pem must be shared with the team out-of-band (it is gitignored and never committed), and the
// previous key is superseded. If you can get the canonical key.pem instead, prefer that (no id churn).
//
// What it writes:
//   extension/key.pem                          the new RSA-2048 private key (gitignored)
//   extension/manifest.json  -> `key`          base64 of the public key DER (fixes the unpacked id)
//   src/main/connection-tab-link.mjs -> CONNECTOR_EXTENSION_ID   the derived 32-char id
// Then run `node scripts/build-extension.mjs` to pack extension.crx with the new key.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const keyPath = join(root, 'extension', 'key.pem')
const manPath = join(root, 'extension', 'manifest.json')
const linkPath = join(root, 'src', 'main', 'connection-tab-link.mjs')

// 1) fresh RSA-2048 private key (the algorithm Chrome uses to sign extensions)
execFileSync('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', keyPath])

// 2) public key as DER SubjectPublicKeyInfo — the exact bytes Chrome hashes for the id AND the manifest `key`
const pubDer = execFileSync('openssl', ['pkey', '-in', keyPath, '-pubout', '-outform', 'DER'])

// 3) extension id = first 16 bytes of SHA256(pubDer), each nibble (0..15) mapped to a..p
const hash = createHash('sha256').update(pubDer).digest()
const id = [...hash.subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('')
const keyB64 = pubDer.toString('base64')

// 4) sync the manifest `key`
const man = JSON.parse(readFileSync(manPath, 'utf8'))
man.key = keyB64
writeFileSync(manPath, JSON.stringify(man, null, 2) + '\n')

// 5) sync CONNECTOR_EXTENSION_ID (32 lowercase a-p chars)
const link = readFileSync(linkPath, 'utf8')
const next = link.replace(/(CONNECTOR_EXTENSION_ID = ')[a-p]{32}(')/, `$1${id}$2`)
if (next === link) {
  console.error('FAILED to rewrite CONNECTOR_EXTENSION_ID in connection-tab-link.mjs (pattern not found)')
  process.exit(1)
}
writeFileSync(linkPath, next)

console.log('minted connector signing key + rotated id:')
console.log('  id  =', id)
console.log('  key =', keyB64.slice(0, 32) + '…')
console.log('synced extension/manifest.json `key` + CONNECTOR_EXTENSION_ID.')
console.log('next: node scripts/build-extension.mjs   (packs extension.crx with the new key)')
