# Notarization + signing: session handoff (2026-06-25)

## TL;DR
Notarization WORKS. The 5 release secrets produce a **notarized, stapled, Gatekeeper-clean DMG + zip** with every helper signed. Proven locally this session via `npm run dist`. One integration gap: the CI workflow (`.github/workflows/release.yml`) only builds a notarized **ZIP**, not a DMG. The full DMG-notarize path currently lives only in `scripts/dist-mac.sh`.

## The 5 secrets (set on github.com/blitzdotdev/BlitzOS since 2026-06-11, confirmed via `gh secret list`)
| Secret | What it is | Local source (to regenerate) |
|---|---|---|
| MAC_CERT_P12 | base64 of the Developer ID Application .p12 | keychain identity `Developer ID Application: Minjune Song (4GS43493GL)`, hash `B085A90AC2ECD302387D6677153848BF8C4DBD87` |
| MAC_CERT_PASSWORD | the .p12 export password | chosen at export time, not on disk |
| APPLE_API_KEY_P8 | **RAW** .p8 PEM text (NOT base64) | `~/private_keys/AuthKey_84WK494H33.p8` |
| APPLE_API_KEY_ID | 10-char key id (`84WK494H33`) | `~/.zshrc` `APPLE_API_KEY` |
| APPLE_API_ISSUER | 36-char issuer UUID | `~/.zshrc` `APPLE_API_ISSUER` |

Gotcha: `release.yml` writes the key raw (`echo "$ASC_KEY_P8" > asc.p8`), so `APPLE_API_KEY_P8` must be the raw PEM, not base64. (`dist-mac.sh` instead reads `APPLE_API_KEY_PATH` = the file path. Different mechanism, do not conflate.)

## What I proved
1. `npm run dist` (`scripts/dist-mac.sh`) signs the 3 native helpers, builds the app, packages dmg+zip, notarizes the app via electron-builder, then separately signs + notarizes + staples the dmg container.
2. **First run failed at notarization: HTTP 403 "A required agreement is missing or has expired."** This is NOT a credential failure (403 not 401 means the key authenticates; the block is account-level). Confirmed independently with `xcrun notarytool history`. Fix: the Account Holder signs the Apple Developer Program License Agreement at developer.apple.com/account (separate from App Store Connect's Paid/Free Apps agreement). Propagation to the notary service took a few minutes after signing.
3. After the agreement cleared, `npm run dist` succeeded end to end. `scripts/verify-signed-dist.sh` reports:
   - Tier 1 (signing): app + 4 helpers (Computer-Use, Island, notch-geometry, tmux) + 19/19 Mach-O all Developer-ID signed (team `4GS43493GL`), hardened runtime, `codesign --verify --deep --strict` clean.
   - Tier 2 (notarization): app stapled + Gatekeeper "Notarized Developer ID"; dmg signed + stapled + Gatekeeper accepted. PASS.

## Verification gate (new this session)
`scripts/verify-signed-dist.sh [app|dmg]` — deep Tier1+Tier2 proof, exits nonzero on any signing fail or expected notarization fail. Run after any packaging step. It keys Gatekeeper checks off `spctl`'s exit code on purpose: do NOT "simplify" it to grep for "Notarized Developer ID", since that substring also matches "**Un**notarized Developer ID" (the false-positive I already fixed once).

## Integration gap: make CI ship a notarized DMG
`release.yml` packages `--mac zip` only (electron-builder.yml `mac.target` = zip), and electron-builder notarizes only the `.app` (the zip carries it). The dmg container is never built or notarized in CI, so a downloaded dmg would warn on mount. To match the proven local DMG:
1. Add `dmg` to targets: package step `--mac dmg zip` (or add `dmg` to electron-builder.yml `mac.target`).
2. After electron-builder, for each `release/*.dmg`: `codesign --force --sign "$IDENTITY" --timestamp`, `xcrun notarytool submit --wait`, `xcrun stapler staple` + `validate`. Reference implementation: `scripts/dist-mac.sh` lines ~61-70.
3. Add a CI step running `scripts/verify-signed-dist.sh` as the gate.

Cleanest option: have CI call `scripts/dist-mac.sh` directly (it already does all of the above) instead of duplicating the electron-builder call in `release.yml`. Note the env differs: dist-mac.sh reads `APPLE_SIGNING_IDENTITY` + `APPLE_API_KEY` (key id) + `APPLE_API_KEY_PATH` (.p8 file) + `APPLE_API_ISSUER`, while release.yml reads the 5 secrets. If you route through dist-mac.sh in CI, map the secrets to those env names and write the .p8 to a temp file for `APPLE_API_KEY_PATH`.

## Known finding (cosmetic, not a blocker)
electron-builder's deep re-sign overwrites the CU helper's entitlements with Electron's, dropping `com.apple.security.automation.apple-events`. Harmless today: the CU helper drives apps via Accessibility/CGEvent, not Apple Events (`main.swift` = 0 Apple Events calls, 56 AX/CGEvent). Optional cleanup: an `afterSign` hook that re-signs `Contents/Resources/BlitzOS.app` with `native/computer-use-helper/entitlements.plist`, then re-seals the parent app (not `--deep`) before notarize.

## Files
- Created: `scripts/verify-signed-dist.sh`
- Unchanged: `scripts/dist-mac.sh`, `electron-builder.yml`, `.github/workflows/release.yml`
- Note: `scripts/oss-publish.mjs` was already untracked at session start; I did not author or run it.

## Open (separate thread, user is drilling in now)
The "route privileged ops through the CU helper, fall back to Electron" pattern ALREADY exists and is the established design:
- `onboarding.ts` `runScan()` (lines 924-989) PREFERS `computerUseHelper().runScan()` (the scan reads Messages/Mail/Safari under the HELPER's FDA, so BlitzOS itself never needs FDA) and only falls back to an Electron-child `spawn` when the helper is absent/ungranted.
- `openChromeJsRow()` (line 456) routes osascript through the helper the same way, so the Automation/Accessibility grant lands on the helper.
- `connection-window-link.ts` drives all AX/CGEvent/screenshot through `helper.call(...)`.

So onboarding already follows the model. My earlier "scan runs under Electron" framing was imprecise: that is the FALLBACK, not the primary path. Correction logged.

The full enumeration (workflow `tcc-electron-sweep`: 17 triggers, 9 new) and the consolidated fix + test plan now live in **`plans/tcc-route-through-cu-plan.md`**. Headline: the triggers collapse to a few consent classes (Control Chrome, Control Safari, Control System Events, Screen Recording, FDA, guest media); the linchpin fix is one new helper `osa` op (stdout-capturing osascript exec) plus prefer-helper/fallback-Electron routing at the connection links + a few other sites, blitz-chrome's System-Events automation gets eliminated via the helper `activate` op, wallpaper Screen-Recording is a dormant true "just route", and onboarding gets a pre-grant step for the default browser. No agent doctrine change.
