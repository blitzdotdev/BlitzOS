# BlitzOS CDP Bridge (`cdp-ext`)

Minimal MV3 extension whose only permission is `debugger`. Its service worker connects out to a
localhost WebSocket and relays Chrome DevTools Protocol commands through `chrome.debugger`, giving the
agent **trusted, renderer-level input into background tabs** (Google Docs / Figma canvas and other
surfaces that ignore synthetic-DOM and osascript events) with **no focus steal**.

This is the separate-extension path (distinct from the `extension/` "BlitzOS Connector"). It was proven
out in the off-repo verify harness `/Users/Shared/chrome-osa-verify/` and promoted into the repo here.
Only the manifest `name` was cleaned (the harness copy was tagged "(test)"); `sw.js` is verbatim.

## Protocol (JSON over the WS)
- `{id, cmd:'listTargets'}` → list attachable page targets
- `{id, cmd:'attach', tabId}` / `{id, cmd:'detach', tabId}`
- `{id, cmd:'cdp', tabId, method, params}` → `chrome.debugger.sendCommand` (the one verb that exposes all of CDP)

Replies: `{type:'reply', id, result|error}`. Default port `9234` (see `sw.js`).

## Loading
Load unpacked into a dedicated/AI Chrome profile (Developer mode → Load unpacked → this folder), or via
whatever the AI-Chrome onboarding wires up. The `chrome.alarms` keep-alive reconnects the SW after MV3
eviction.

## Background / design
- `plans/cdp-browser-blitzos-plan.md`: integration plan (CDP into the connector vs. this separate ext)
- `plans/cdp-extension-journal.md`: running journal with the verified CDP findings
