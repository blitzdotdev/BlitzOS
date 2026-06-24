# blitz.dev app card: claim button, preview cards, instant open

Three fixes to how a blitz.dev app shows up in the island chat. All DONE + green
(`npm run check`); the visual feel is the only thing left to eyeball in `npm run dev`.

## 1. Claim button (done)
Anon apps delete at ~12h unless claimed. `new_app` gets a `claim_url`
(`https://blitz.dev/claim/<slug>`) but `share_app` never carried it.
- `os-tools.mjs`: `normalizedClaimUrl` (apex `blitz.dev` only) + a `preview_url -> claim`
  cache. `new_app` fills it; `share_app` auto-attaches `claimUrl` (no agent threading;
  optional explicit override).
- `osActions.ts`: `claimUrl`/`expiresAt` persist on the part. `types.ts`: new fields.
- `IslandPanel.tsx` + `island.css`: a "Claim app" pill left of the X in the expanded
  view, opens the claim page externally. Verified end-to-end headless (4/4).

## 2. Preview cards, never the generic icon (done)
The rich preview card already existed (`.isl-app-card.preview`, srcdoc iframe) but the
agent wasn't passing a `preview`, so it fell back to the bland icon card.
- Doctrine (`blitzos-agents.md`) + `new_app`/`share_app` descriptions now MANDATE it:
  build the app, then generate a **460x300 static HTML/CSS preview** that is a
  **minified, glanceable representation** of the app (minimum words, heavy visuals, the
  app's real color theme, beautiful + uncluttered, lightweight, inline CSS, no scripts),
  passed as `preview`. No preview = the fallback icon (not acceptable for a deliverable).
- `island.css`: preview card locked to 460x300, centered (`margin auto`).

## 3. Instant open (done)
Was a cold load on click (measured ~4s empty, worse for real JS apps + post-deploy 522s).
- `IslandPanel.tsx`: ONE persistent app iframe. `src` = the open app, else the latest
  card url (prewarmed offscreen, `opacity:0` + click-through so it loads un-throttled).
  Opening the latest = same src = instant reveal, no remount. Stays warm across close.
  A ~2.5s arm delay before idle-prewarm dodges the post-deploy 522 window; opening always
  arms immediately. `appFrameLoaded` replaced by url-keyed `appLoadedUrl`/`appViewerReady`.
- `island.css`: `.isl-app-warm:not(.viewing)` = the offscreen prewarm state.

## Notes / residual risk
- One latest app runs warm in the background while the island is open (bounded to one).
- TODO: if a prewarm ever lands inside the 522 window the iframe could cache a transient
  error; the 2.5s delay dodges the usual window — widen if seen in practice.

## Verify
`npm run check` green. Live in `npm run dev`: share an app -> card is the 460x300 preview,
centered; click -> opens near-instantly; expanded view has the Claim pill -> opens claim
page; relaunch -> claim persists.
