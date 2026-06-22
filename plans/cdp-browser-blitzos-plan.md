# Plan: CDP browser for BlitzOS (add CDP to the connector + per-agent AI profile)

Don't build a new extension. **Add `chrome.debugger` (CDP) to the EXISTING connector** and deploy it
**unpacked into ONE dedicated "BlitzOS AI" Chrome**, where **each chat agent gets its own background
window** and one login is shared by all agents. Reuses the connector's whole proven transport (auth,
reconnect, backoff, perception, registry, every `connection_*` tool + UI). The only new capability code is
the per-agent window/profile model. Live proof for all CDP claims: `plans/cdp-extension-journal.md`.

## Why reuse, not a new extension
The reliability stack a fresh extension would re-implement already exists and is wired: port-range probe,
fast-reconnect, exponential backoff, 15s ping, alarms keep-alive, origin+token auth, drop→unbind
(`connection-tab-link.mjs` + `extension/sw.js`), plus tab-event perception, `listTabs`/`listWindows`, the
registry binding, and all `connection_*` tools. A separate extension duplicates all of it. The only thing
the connector lacks is `chrome.debugger`. The lone argument for a separate ext (permission minimalism /
Web Store acceptance) is moot when we load unpacked into an isolated AI profile.

## Decision
- **One deployment:** the connector (+ CDP) is loaded unpacked into the dedicated AI Chrome ONLY. The
  force-install-into-the-user's-real-Chrome path is retired for this model (so the single-socket transport
  sees exactly one browser). If you ever want BOTH the user's browser AND the AI profile, that needs
  multi-socket support in connection-tab-link + omitting `debugger` from the user-browser build — out of scope here.
- **AI Chrome** = a dedicated instance with its own `--user-data-dir`, BlitzOS-supervised (relaunch on death),
  like the computer-use helper. Full isolation from the user's real Chrome. One profile ⇒ shared login.
- **Per agent** = its own background window in that one profile (proven: 2 windows, concurrent trusted input,
  zero focus steal, `cdp-windows.mjs`).

## Capability audit (purely additive — nothing removed, so nothing lost)
| capability | today (connector) | after |
|---|---|---|
| read / run_js / listTabs / listWindows | scripting / userScripts / tabs / windows | UNCHANGED (kept) |
| perception wake (nav/title/close) | chrome.tabs.onUpdated/onRemoved | UNCHANGED (kept — still has `tabs`) |
| transport (auth, reconnect, backoff, ping, alarms, drop→unbind) | connection-tab-link + sw.js | UNCHANGED (kept) |
| act | synthetic DOM (no canvas) | + **CDP `Input.*` trusted path** → drives Docs/Figma canvas, background |
| screenshot | none | + **CDP `Page.captureScreenshot`** (the `connection_read {screenshot}` flag already exists) |
| read (canvas) | DOM empty on canvas | + **CDP `Accessibility.getFullAXTree`** |
| per-agent window | user picks a tab | + **`openAgentWindow(agentId)`** (one window per agent, shared login) |

Later cleanup (optional, not blocking): once CDP covers read/act/run_js, progressively drop
`scripting`/`userScripts`/`all_urls` (and, with CDP event-forwarding, `tabs`) → the connector converges to a
minimal debugger-only extension by trimming, no rewrite.

## The commit
1. **`extension/manifest.json`** — add `"debugger"` to `permissions`. (Pinned `key` ⇒ the id, and the
   server origin check, stay valid when loaded unpacked.)
2. **`extension/sw.js`** — add three verbs: `cdp {tabId,method,params}` (chrome.debugger attach +
   sendCommand, auto-reattach on `onDetach`), `newWindow {url}` (chrome.windows.create `{focused:false}` →
   returns the new tab id; no extra permission), `navigate {tabId,url}`. Route `act` through CDP `Input.*`
   when `args.trusted`/canvas; add CDP screenshot. Keep existing read/act/run_js as-is.
3. **`src/main/connection-tab-link.mjs`** — add `openAgentWindow(agentId)` (newWindow → bind a connection
   owned by agentId, `type:'tab'`, ref=tabId) and a `navigate` verb in the adapter; route
   `connection_read{screenshot}` and trusted/coordinate `act` to the new CDP verbs.
4. **`src/main/connection-ops.mjs` / `.d.mts`** — add `connectionOpenBrowser(agentId)` + `connectionNavigate`
   ops; register the link's new methods.
5. **`src/main/os-tools.mjs`** — add `connection_open_browser {agent}` (open/get my window) and
   `connection_navigate {connection,url}`. `connection_read{screenshot}` and `connection_act{x,y}` already
   exist in the schemas — just newly backed by CDP.
6. **`src/main/ai-browser.ts` (NEW)** — launch + supervise the dedicated AI Chrome (`--user-data-dir`),
   open it at chrome://extensions and reveal the `extension/` folder for onboarding, report connected/needs-setup.
7. **`src/main/index.ts`** — wire ai-browser; point the connector deployment at the AI Chrome; retire the
   auto force-install-into-user-Chrome call for this model.

## End conditions (mapped)
- **2-step onboarding:** AI Chrome opens at chrome://extensions + the `extension/` folder is revealed → user
  flips Developer mode + drags the folder. No admin, no Web Store. (Cost: a dev-mode nag on AI-Chrome start.)
- **No focus steal:** background windows (`focused:false`) + CDP trusted input. PROVEN (`cdp-windows.mjs`).
- **Persistent + reconnect:** all already in the connector — SW `onStartup`+alarms keep-alive, server rebinds
  same port + ext port-probes back, drop→unbind, `connectionRestoreAll`. Add: BlitzOS relaunches the AI
  Chrome if it dies; agents re-open their window on demand after a restart; `onDetach` → auto-reattach.
- **Parity + more:** the audit table (purely additive).

## Verify during impl (everything else already PROVEN by the journal)
- `cdp` verb on the connector drives a background window end-to-end (attach → Input → read-back).
- `chrome.windows.create` (no `tabs`-perm dependency for the id) returns an attachable tab id.
- Reconnect after AI-Chrome restart with a window persisted; reconnect after a BlitzOS restart.
Reuse harnesses: `/Users/Shared/chrome-osa-verify/{cdp-ext,cdp-server.mjs,cdp-port.mjs,cdp-windows.mjs}`.
