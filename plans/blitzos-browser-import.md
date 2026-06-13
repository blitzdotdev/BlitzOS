# BlitzOS — literal browser import (make the built-in browser feel like theirs)

**Status:** Research / feasibility, 2026-06-13. No code yet. Spun out of the onboarding browser-signal work (`plans/onboarding-case-file.md`), where the user clarified they want the *actual* browser data imported into BlitzOS's built-in browser, not just folded into the agent's onboarding context.

## Goal

When a user adopts BlitzOS, the built-in browser (the `web` surface, one main-owned `WebContentsView` per tab, all sharing the `persist:agentos` Chromium session) should feel like *their* browser on first run, the way opening Arc or a fresh Chrome offers "import from Safari/Chrome." The migration tax (re-logging into every site, losing bookmarks and open tabs) is what keeps people in their old browser. Killing it is the unlock.

This is **separate from the onboarding agent-context import** (already shipped: the scan reads history/bookmarks and the live working set, the agent leads the interview from it). That fed the agent's *understanding*. This feeds the *browser itself*.

## The single most important fact: it all lands in one session

Every web surface uses `session.fromPartition('persist:agentos')` (`webcontents-view-host.ts`, `guest-capabilities.ts`, `persistence.ts`). So "import" means **populating that one session and its sibling stores** before/at first use. There is no per-profile split to reconcile. Cookies, storage, and (if added) extensions all attach to that partition.

## What there is to import, by value × effort

Ranked by user value, with honest effort/risk. Sources: Chrome/Chromium-family (`~/Library/Application Support/<Brand>/<Profile>/`) and Safari (`~/Library/Safari/`, FDA-gated). The scan's `CHROMIUM_BROWSERS` map + profile-walk already locate these.

### 1. Cookies / login sessions — HIGHEST value, MEDIUM-HARD
The killer feature: open the BlitzOS browser and already be signed into Gmail, GitHub, the user's SaaS, everything. Without this, "import" feels hollow.

- **Where:** Chrome `<Profile>/Cookies` (SQLite, table `cookies`; `host_key`, `name`, `path`, `expires_utc`, `is_secure`, `is_httponly`, `samesite` are plaintext; `encrypted_value` is encrypted).
- **The encryption (macOS Chrome):** `encrypted_value` is prefixed `v10`/`v11`, AES-128-CBC, key = PBKDF2-SHA1(passphrase, salt=`saltysalt`, iters=1003, len=16). The passphrase is the **"Chrome Safe Storage"** generic password in the login Keychain. Reading it via `security find-generic-password -wgs "Chrome Safe Storage"` (or the Keychain API) raises a **one-time Keychain access prompt the user must Allow**. v11 (Linux) differs; macOS is v10. Newer Chrome (≈v127+) added app-bound encryption for some cookies — confirm coverage during the spike; un-decryptable cookies are skipped, not fatal.
- **Inject into BlitzOS:** `session.fromPartition('persist:agentos').cookies.set({url, name, value, domain, path, secure, httpOnly, expirationDate, sameSite})` per decrypted cookie. The API supports every field the table carries. Host-only vs domain cookies map to whether `domain` has a leading dot.
- **Safari:** cookies are in a binary `Cookies.binarycookies` (+ the network cache), not a clean SQLite, and not Keychain-encrypted the same way. Lower priority; do Chrome first.
- **Effort:** a self-contained decrypt module (port a known-correct implementation; do NOT hand-roll the crypto) + a cookie-set loop. **Risk:** the Keychain prompt is unavoidable and must be framed as a consent step (like the FDA/Automation pre-board steps). App-bound-encrypted cookies may be partially unreadable.

### 2. Bookmarks — HIGH value, EASY (BlitzOS already has the pieces)
- BlitzOS already has a **machine-global bookmark store** (`readBookmarks`/`toggleBookmark`, root journal) and the scan **already reads Chrome's `Bookmarks` JSON**. Import = read Chrome's `Bookmarks` (JSON, `roots.bookmark_bar`/`other`/`synced`, recursive `children` with `{type:'url', name, url}`) and Safari's `Bookmarks.plist`, then add each to the BlitzOS store (de-dupe by url). Folder structure flattens unless we extend the store to hold folders.
- **Effort:** low. Mostly a reader + a merge. **Risk:** none.

### 3. Open tabs (the working set) — MEDIUM value, TRIVIAL (already captured)
- Already captured by the onboarding Automation step into `userData/preboard-tabs.json` (grouped by window). Import = `open_window` each tab (optionally as one surface per window, or a saved set the agent offers to reopen). The worktabs board card already does one-tap reopen.
- **Effort:** trivial. **Risk:** opening 30 tabs at once is heavy (each tab is a full WebContentsView); offer per-cluster, not all-at-once.

### 4. History — LOW-MEDIUM value, MEDIUM
- The built-in browser has per-tab `navigationHistory` but **no aggregate history store** (surfaces persist as workspace nodes; there is no global "history" list). So importing history has nowhere to live until BlitzOS grows a history store + a UI (address-bar autocomplete, a history view). The scan already mines history for onboarding context, which is most of the value.
- **Recommendation:** defer until BlitzOS has a history feature to import *into*. Not worth a store no UI reads.

### 5. Saved passwords — LOW value here, HARD. Skip.
- Chrome `Login Data` (SQLite, same Safe-Storage encryption). But BlitzOS has **no password manager / autofill UI**, so imported passwords have nowhere to act. If cookies/sessions are imported (#1), the user is already logged in, which is what they actually want. **Skip** unless/until BlitzOS builds autofill. (And importing plaintext passwords into a new store is a security liability to avoid.)

### 6. Extensions — LOW-MEDIUM value, HARD. Defer.
- Electron's `session.loadExtension(path)` supports **unpacked** extensions with **partial** MV2/MV3 support and **no Chrome Web Store / auto-update / background-service-worker parity**. Importing a user's installed extensions reliably is not feasible today (CRX unpack + compatibility gaps). **Defer**; if pursued, scope to a curated allowlist of known-compatible extensions, not a blind import.

## Recommended phasing

- **Phase 1 — bookmarks + working set (days, low risk).** Read Chrome/Safari bookmarks into the BlitzOS bookmark store; offer to reopen working-set clusters. Pure win, no new crypto, no scary prompt. Ship as a post-onboarding "bring your browser in" offer (the interview already proposes it).
- **Phase 2 — cookies/sessions (the unlock, behind one consent).** A signed, self-contained cookie-decrypt + `cookies.set` importer for Chrome on macOS, gated by a Keychain-access consent step modeled on the pre-board FDA/Automation pattern. This is what makes BlitzOS's browser actually usable as a daily driver. Spike the Keychain prompt + app-bound-encryption coverage first.
- **Phase 3+ — history store, then extensions, then Safari cookies, then passwords** — each only after the feature it imports *into* exists. Do not import data nothing reads.

## Security & consent (non-negotiable)

- **Cookies and passwords are secrets.** The scan's `SECRET_RE` deliberately never opens `Cookies`/`Login Data`. The importer is a *separate, explicitly-consented* path, not part of the silent scan. Decrypt in memory, write only into the session, never to a log or a plaintext file.
- **One clear consent per sensitive import**, framed like the pre-board permission steps (what, why, one button). The Keychain prompt for the Safe Storage key is itself a consent gate; pair it with an in-app explanation so it is not a mystery dialog.
- **Never hand-roll the crypto.** Port a known-correct Chrome-cookie-decrypt implementation; cover the v10/app-bound cases explicitly; skip what can't be decrypted rather than guessing.
- **Idempotent + reversible.** Re-running import must not duplicate; the user should be able to clear the imported session (`session.clearStorageData`).

## Open questions

- App-bound cookie encryption coverage on the user's Chrome version (affects how complete #1 is).
- Multi-profile: which Chrome profile to import (default vs picker). The scan already walks profiles; reuse that.
- Whether bookmarks should grow folder support in the BlitzOS store, or flatten on import.
- Whether "import" is a one-shot at onboarding or a re-runnable command (recommend re-runnable, behind the same consent).

## Pointers

- Session/partition: `src/main/webcontents-view-host.ts`, `guest-capabilities.ts`, `persistence.ts` (`persist:agentos`).
- Bookmark store: `readBookmarks`/`toggleBookmark` in `src/main/workspace.mjs`.
- Browser/profile location + already-working readers: `srcChromium` in `scripts/onboarding-scan.mjs` (`CHROMIUM_BROWSERS`).
- Working-set capture: `requestAutomation` in `src/main/onboarding.ts` → `userData/preboard-tabs.json`.
- Consent-step pattern to mirror: the pre-board FDA/Automation flow (`plans/onboarding-case-file.md`, "Pre-board permission sequence"; `plans/blitzos-computer-use-helper.md`).
