# Chrome Connector install — macOS reality + launch blocker

## Finding (researched + empirically tested 2026-06-20)
On a normal **non-MDM Mac there is NO way to auto-install our self-hosted Chrome connector.** Chrome blocks every programmatic path on macOS by design:
- **`external_crx`** (local .crx via External Extensions): blocked on macOS since **Chrome 44** (Linux-only). Tested headful — Chrome ignored the registration, nothing installed.
- **`external_update_url`** (External Extensions): macOS honors **only Chrome Web Store** update URLs, not our self-hosted one.
- **`ExtensionInstallForcelist`** (managed policy): the only true auto-install, but needs the Mac **MDM-enrolled** + `/Library/Managed Preferences`. This machine is neither (`MDM enrollment: No`); Chrome ignores a hand-written managed file with no provider.
- **`--load-extension`** at launch: dodges chrome://extensions but is non-persistent (gone on the next normal Chrome start), nags "disable developer mode extensions", and the MV3 service worker didn't reliably load in tests. Not viable.

Net: the ladder is just **manual (load-unpacked / drag .crx)** or **Chrome Web Store (1-click Add)**. Nothing in between.

## 🔴🔴 BIG FAT TODO — PUBLISH TO THE CHROME WEB STORE (LAUNCH BLOCKER) 🔴🔴
We cannot ship the connector to real users without this. It is the ONLY clean, persistent, non-manual install on macOS.
1. Chrome Web Store dev account ($5 one-time).
2. Upload a `.zip` of `extension/` (the store assigns the id + re-signs; the manifest `key` is dropped for store builds).
3. Review ~1-3 days — MV3 + `userScripts` + `<all_urls>` + a localhost WebSocket may draw scrutiny; be ready to justify or trim.
4. Then BlitzOS opens the store page → user clicks "Add to Chrome" (1 click, persists). For managed fleets, MDM force-install by store id.

## If the Web Store is NOT possible — make the unpinned install AS STREAMLINED AS POSSIBLE (open)
Get as close to one-click as Chrome allows without the store:
- Bundle the `.crx` in the packaged BlitzOS.app; on "Connect Chrome" **open `chrome://extensions`, reveal the `.crx` in Finder, and show a 1-line "drag this onto the page"** — drag-drop install needs NO Developer mode, so it's lower-friction than load-unpacked.
- Or a first-run wizard: a copy-path button + a 5s screen-grab of the drag.
- Decide once Web Store timing is known.

## Notes
- The id was briefly rotated to a throwaway local key while chasing the dead force-install; that was never committed and is reverted to the canonical key. Use the canonical/team key (or the store's) when publishing.
- `connection-install.ts` now degrades gracefully on non-MDM: clear load-unpacked steps instead of the `chown` failure, and the boot auto-install is gated to MDM Macs (no useless admin prompt).
