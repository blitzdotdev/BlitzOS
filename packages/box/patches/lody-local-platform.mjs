#!/usr/bin/env node
// Re-enables Lody's local (OSS) platform in the PUBLISHED `lody` npm bundle.
//
// WHY THIS EXISTS. `lody@0.88.1` on npm is the CLOUD build. Its Vite config
// inlines `process.env.LODY_PLATFORM` as the literal `"cloud"`, so every one of
// the four call sites reads
//
//   resolvePlatformKind("cloud")
//
// and the local branches — `loadOrCreateLocalIdentity`, the local-first Loro
// repo, the `.lody-oss` data directory — are dead code no environment variable
// can reach. Measured 2026-08-29: an unpatched `lody start` opens NO socket at
// all. It reaches https://backend.lody.ai for a device-authorization login and
// waits there. A BlitzOS box has no Lody account and must never acquire one.
//
// Patched, the same binary prints "Starting in local platform mode (no account,
// no cloud services)", creates a local identity, provisions an implicit `lw_*`
// workspace, and opens the four unix sockets the box gateway needs. See
// plans/evidence/lody-phase1.md.
//
// WHY A NODE SCRIPT AND NOT A .patch FILE. `dist/index.js` is one 12.8 MB
// minified-ish line-poor bundle; a unified diff against it carries megabytes of
// context and re-rolls on every release. The edit is four occurrences of one
// exact string, so the script asserts the count instead — a bundle that no
// longer contains exactly four fails the image build.
//
// THE SHA GUARD is the version pin's teeth. `EXPECTED_INPUT_SHA256` is the
// sha256 of `lody@0.88.1`'s `dist/index.js` as published. Bumping the version in
// the Dockerfile without re-auditing this patch fails HERE, loudly, at build
// time — not silently at run time on a member's box.
//
// Recorded in vendor/lody/BLITZ-PATCHES.md. Usage:
//   node lody-local-platform.mjs <path to lody/dist/index.js>

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** sha256 of `dist/index.js` inside the published `lody@0.88.1` tarball. */
const EXPECTED_INPUT_SHA256 = "9989ffd086a690c4d74555b0ef5e7ecd4830f25506b2fa0cda0808bfe57ca8e9";
const EXPECTED_VERSION = "0.88.1";
const FIND = 'resolvePlatformKind("cloud")';
const REPLACE = 'resolvePlatformKind(process.env.LODY_PLATFORM||"cloud")';
const EXPECTED_OCCURRENCES = 4;

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: lody-local-platform.mjs <path to lody/dist/index.js>");
  process.exit(2);
}

const source = readFileSync(target, "utf8");
const actualSha = createHash("sha256").update(source, "utf8").digest("hex");
if (actualSha !== EXPECTED_INPUT_SHA256) {
  console.error(
    `lody-local-platform: refusing to patch ${target}.\n` +
      `  expected sha256 ${EXPECTED_INPUT_SHA256} (lody@${EXPECTED_VERSION} as published)\n` +
      `  got      sha256 ${actualSha}\n` +
      "  The pinned lody version moved. Re-audit the four resolvePlatformKind call\n" +
      "  sites in the new bundle, re-measure a local-mode start, then update\n" +
      "  EXPECTED_INPUT_SHA256 and EXPECTED_VERSION here and the pin in\n" +
      "  packages/box/Dockerfile together.",
  );
  process.exit(1);
}

const occurrences = source.split(FIND).length - 1;
if (occurrences !== EXPECTED_OCCURRENCES) {
  console.error(
    `lody-local-platform: expected ${EXPECTED_OCCURRENCES} occurrences of ${FIND}, found ${occurrences}.`,
  );
  process.exit(1);
}

writeFileSync(target, source.split(FIND).join(REPLACE));
console.log(
  `lody-local-platform: patched ${occurrences} call sites in ${target} (lody@${EXPECTED_VERSION}).`,
);
