# BlitzOS — browser import (inherit the user's Google sign-in, the Dia move)

**Status:** **Phase 1 BUILT 2026-06-13, pending live GUI verification.** The user pointed at Dia: on first run it logged them into Gmail and Claude, and on x.com it shows Google's "Sign in to x.com with Google / Continue as Minjune" one-tap. BlitzOS now does the same, **focused on importing the Google sign-in from Chrome** so any site that accepts Google OAuth becomes one-click. The v10 decrypt is empirically proven on a real Chrome; the account picker + inject flow compiles, builds, and unit-tests pass; the one untested-here piece (no display in this env) is the live "open Gmail and you are signed in" confirmation, which the user runs.

**Built (Phase 1):** `src/main/browser-import-core.mjs` (+`.d.mts`) — profile enumeration, Safe Storage key read, v10 decrypt (SHA256-prefix-verified strip); `src/main/browser-import.ts` — inject into `persist:agentos` via `session.cookies.set`, `importGoogleSignin` orchestration + SID verify; IPC `onboarding:list-import-profiles` / `onboarding:import-signin` (onboarding.ts) + preload bridge; a **Dia-style pre-board "Bring your Google sign-in" step** with a Chrome-account picker (OnboardingFlow.tsx + onboarding.css), persisted in `preboard.json`. Tests: `node scripts/test-browser-import.mjs` (synthetic v10 round-trip + real profile enumeration). **Live-verify next:** pick an account, approve the Keychain prompt, confirm Gmail is signed in and One Tap fires; watch the rotating `__Secure-*PSIDTS` tokens (may force one re-auth).

**Open the working set on the stage (Built 2026-06-13):** when the browser was brought in, the director opens ONE browser surface on the user's first stage holding every captured open tab as a tab strip (`openWorkingSetBrowser` in onboarding.ts → `osCreateSurface{kind:'web', tabs, activeTab:0, focus:true}`, deduped by url, centered on stage 0 by the store cascade). Combined with the sign-in import, those tabs open already logged in. **Lazy session restore** (browser-core change, `webcontents-view-host.ts`): `syncWebContentsViewTabs` now materializes ONLY the active tab on first sight; a background tab stays deferred (no view, no process, no load) until first activated, then keeps its view (activating it re-syncs via the renderer's active-id dep). `navigateWebContentsView` is a no-op for an unmaterialized tab (and no longer falls back to the active tab, which would have hijacked it). So restoring N tabs costs ONE process + one load, not N. `SurfaceDescriptor` gained `tabs`/`activeTab`/`focus`. Live-verify: the browser appears on the stage with the strip full, only the foreground tab loads, clicking a background tab loads it.

## The key insight: you import ONE thing (the Google session), the rest is Google's own behavior

That x.com popup is **Google One Tap** (Google Identity Services / FedCM). It is not anything the browser does per-site. It appears because the browser holds a **live Google session** (the Google account cookies on `.google.com` / `accounts.google.com`). Once that session exists:
- Gmail, Docs, Drive, etc. are already logged in (same cookies).
- Every "Sign in with Google" / GIS site shows one-tap "Continue as <you>" (x.com, and most of the web).
- OAuth consent flows skip the password step because `accounts.google.com` already knows who you are.

So "import the Google sign-in" reduces to **copy the Google account cookies from Chrome into BlitzOS's session.** Google is the universal IdP, so getting just Google right buys a huge fraction of the user's logins for free. This is the highest-leverage subset of a general cookie import.

## What Dia actually does (reverse-engineered from the shipped app, 2026-06-13)

`/Applications/Dia.app` is native Swift+Chromium. Its bundle symbols name the mechanism outright:
- An **`Onboarding`** module with `ImportPasswordsAndCookiesResultView` / `…ViewModel` / `…Controller` and an `Importer` + `Importer.Listener` — i.e. a first-run step that **imports passwords AND cookies**, with progress.
- `ADK.ImporterProfile` + `_loadImporterSources` — it enumerates source browsers and **picks a profile** (necessary: real Chrome installs have many profiles).
- `AuthFlow.PendingSSOCookies` — explicit **SSO-cookie handling** (the Google/SSO session is treated specially).
- `PasswordsAndCookiesUpsellView` — they actively upsell the import.
- A `keychain-access-groups` entitlement — it reads the **Chrome Safe Storage** key from the Keychain to decrypt the cookies.

So Dia's move is precisely: at onboarding, pick a Chrome profile, read the Safe Storage key from Keychain, decrypt the cookies (and passwords), and load them into its own session, SSO cookies included. No magic, no private API. We can do the same with Electron's `session.cookies.set`.

## Verified on this machine (2026-06-13)

- Chrome cookies are **readable without Full Disk Access** (they live in the user's own `~/Library/Application Support/Google/Chrome/`, not a TCC-protected container — same reason the scan already reads Chrome history). The file is `<profile>/Cookies` (older layout) or `<profile>/Network/Cookies` (newer); check both. Locked while Chrome runs, so copy + open immutable (the scan's `sqliteQuery` pattern).
- This user has **6 profiles, no "Default"** (`Profile 2,4,5,6,8,9`), each a different Google identity (`mjsong2021`, `minjunesv0`, `farsleep`, `andrew.cmu.edu`, `Zanny`, `blitzdotdev`). Profile display names come from `Chrome/Local State` → `profile.info_cache[*].{name,user_name}`. **An account picker is mandatory** (you cannot guess which Google login they want; Dia's `ImporterProfile` exists for exactly this).
- **Every profile carries the full Google auth cookie set** on `.google.com`: `SID`, `SAPISID`, `HSID`, `LSID`, `__Secure-1PSID`, `__Secure-3PSID` (plus `APISID`, `SSID`, `__Secure-1PSIDTS`/`-3PSIDTS`). That set is what establishes the login.
- **Not yet tested:** the decryption itself (it needs the Keychain key → one consent prompt). That is the single remaining unknown and the natural first implementation milestone.

## The mechanism, end to end (Google-cookie MVP)

1. **Enumerate profiles** from `Chrome/Local State` `info_cache` → show the user an **account picker** (name + email + avatar). They choose which Google identity to bring in.
2. **Read the cookies** for that profile (`<profile>/Cookies` or `Network/Cookies`), filtered to `host_key` in/under `google.com` and `accounts.google.com`. Copy + immutable-open so a running Chrome doesn't block it.
3. **Get the decrypt key** — the `Chrome Safe Storage` generic password from the login Keychain (Security framework, or `security find-generic-password`). This raises **one macOS Keychain prompt** ("BlitzOS wants to use Chrome Safe Storage"); the user clicks Allow. **This prompt IS the consent gate** — frame an in-app explanation around it like the pre-board FDA/Automation steps.
4. **Decrypt each value** — macOS Chrome cookies are `v10`: AES-128-CBC, key = `PBKDF2-SHA1(safeStoragePw, salt="saltysalt", iterations=1003, len=16)`, IV = 16×`0x20`. On M80+ the plaintext is prefixed with a 32-byte SHA256 domain hash — **strip the first 32 bytes**. (Newer Chrome may app-bound-encrypt some cookies; those that fail to decrypt are skipped, not fatal — verify coverage in the spike.) **Never hand-roll the crypto** — port a known-correct implementation.
5. **Inject into BlitzOS** — for each cookie, `session.fromPartition('persist:agentos').cookies.set({ url, name, value, domain, path, secure, httpOnly, sameSite, expirationDate })`. Critical details:
   - **httpOnly cookies (the Google auth ones) CAN be set here** — `cookies.set` is a main-process API, not `document.cookie`, so it bypasses the httpOnly write restriction. This is the whole reason Electron can do this.
   - **`__Secure-`/`__Host-` prefixes require `secure:true`** (and `__Host-` requires no `domain` + `path=/`), or Chromium silently rejects them and the session is incomplete.
   - Preserve **`sameSite`** (Google uses `None` for cross-site OAuth cookies) and the leading-dot **domain** (host-only vs domain cookie).
   - Convert Chrome's `expires_utc` (microseconds since 1601) → Unix seconds for `expirationDate`; `expires_utc==0` → omit (session cookie). Reuse the scan's `chromeTime` epoch logic.
   - Once set, they persist in BlitzOS's own partition cookie store, **encrypted at rest by Electron safeStorage** — no plaintext lands on disk.
6. **Verify** — open `accounts.google.com` (or `myaccount.google.com`) headless/in a tab and confirm the signed-in state; that is the success signal. Then One Tap + Google OAuth work everywhere automatically.

## Caveats specific to the Google session

- **Rotating bound tokens** (`__Secure-1PSIDTS`/`-3PSIDTS`) refresh server-side. The core `SID`/`SAPISID`/`__Secure-1PSID` set should establish the login; if Google forces one re-validation, it sticks after. Import the whole Google set, not a hand-picked few.
- **One account at a time** for the MVP (the picker). Multi-account-in-one-session is a later nicety.
- This imports the user's **full Google identity** into BlitzOS — powerful and sensitive. The consent copy must say plainly what is being brought in and for which account.

## Phasing (revised — Google sign-in leads)

- **Phase 1 — Google sign-in import (the headline).** Profile/account picker → Keychain-consented decrypt → inject the Google cookies → verify signed-in. Unlocks Gmail/Docs + One Tap + one-click Google OAuth across the web. **First milestone: prove the v10 decrypt on this machine behind the Keychain prompt.**
- **Phase 2 — generalize to all cookies for the chosen profile.** Same pipeline, no host filter → every site the user was logged into comes along (Claude, GitHub, the lot). Phase 1 is literally Phase 2 with a `google.com` filter, so this is mostly lifting the filter + a broader consent.
- **Phase 3 — bookmarks + working set** (easy, no crypto): BlitzOS already has a bookmark store (`readBookmarks`/`toggleBookmark`) and the scan already reads Chrome bookmarks; the working set is already captured. Merge bookmarks in, offer to reopen tab clusters.
- **Later / deferred:** history (no store/UI to import into yet — the scan already mines it for context), passwords (no autofill UI; a liability without one), extensions (Electron's `loadExtension` is partial/unpacked-only). Build the data only once a feature reads it.

## Security & consent (non-negotiable)

- Cookies are secrets and the Google set is the user's whole identity. The importer is a **separate, explicitly-consented path**, never part of the silent scan (the scan's `SECRET_RE` deliberately never opens `Cookies`). Decrypt in memory, inject into the session, never log or write a plaintext value.
- **One clear consent**, paired with the unavoidable Keychain prompt, framed like the pre-board permission steps (what, which account, why, one button).
- **Idempotent + reversible** — re-import overwrites rather than duplicates; offer `session.clearStorageData` to wipe the imported session.
- **Never hand-roll the crypto**; cover `v10` + the 32-byte prefix strip + app-bound failures explicitly; skip what cannot be decrypted.

## Pointers

- Session/partition: `src/main/webcontents-view-host.ts`, `guest-capabilities.ts`, `persistence.ts` (`persist:agentos`); inject via that session's `cookies.set`.
- Profiles + cookie paths + the immutable-copy SQLite read: `srcChromium` in `scripts/onboarding-scan.mjs` (`CHROMIUM_BROWSERS`), and `Chrome/Local State` `profile.info_cache` for names/emails.
- Chrome epoch conversion: `chromeTime` in the scan.
- Bookmark store: `readBookmarks`/`toggleBookmark` in `src/main/workspace.mjs`.
- Consent-step pattern to mirror: the pre-board FDA/Automation flow (`plans/onboarding-case-file.md`; `plans/blitzos-computer-use-helper.md`).
- Reference impls to port the decrypt from (do not invent): the well-known `chrome-cookies-secure` / `pycookiecheat` macOS `v10` recipe (PBKDF2 saltysalt/1003/16, AES-128-CBC, IV=spaces, strip 32-byte prefix).
