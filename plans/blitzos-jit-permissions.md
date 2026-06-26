# Plan: Just-in-time (JIT) macOS permissions

Goal: onboarding asks for ZERO scary permissions. Every TCC grant moves to the moment the user first reaches for the capability that needs it, with a one-line primer right before the OS dialog, so they grant because they want a task done. Keep ALL capabilities (incl. native computer-use). Grants still land on the helper (`dev.blitz.os.computeruse`), one-time, never re-prompt. We'll verify empirically.

## First principle
The agent is fully useful with zero macOS grants: chat, Blitz Chrome (the agent's own CDP browser), and file work need nothing. (MCP is NOT supported.) Grants only buy "act inside the user's EXISTING real browser/apps." So nothing scary belongs in onboarding.

## Capability → grant map (the JIT triggers)
| Connection the user reaches for | Grant(s) needed | OS dialog kind | Trigger point |
|---|---|---|---|
| their real **Chrome/Safari tab** | browser Automation (AppleEvents→Chrome/Safari) + the browser "Allow JS from Apple Events" setting | inline **Allow** (clean) | first "Connect my browser" (list-tabs) / first connectTab |
| a native **app window** | Accessibility (pick + AX drive) + Screen Recording (screenshot) | **Settings toggle** (clunkier) | first "Connect an app window" (opens the picker) |
| **Blitz Chrome** | none (CDP) | — | — |

## What exists today (reuse, don't rebuild)
- AX/Screen: `dragHelperHtml` floating tile → drag the helper bundle into System Settings (`SETTINGS_URL[kind]`), poll the grant, `relaunchForGrant()`. Also `helper.request('accessibility'|'screen')` raises the system prompt. (`onboarding.ts`)
- Automation: `requestHelperAutomation('systemevents'|'browser')` fires a benign Apple Event through the helper → inline Allow → `relaunchForGrant()`. (`onboarding.ts`)
- Chrome "Allow JS": `openChromeJsHelper` drives View ▸ Developer. (`onboarding.ts`)
- Grant state: `helper.status()` → `{accessibility, screenRecording, fullDisk}`. Automation has no status — first use either succeeds or prompts.
- Connections: `conn-connect-tab/window`, `os:pick-start` (already requests Accessibility on pick_start failure, `index.ts:953`), the browser osa call already prompts JIT when the grant is missing.
- The onboarding wall: `nextStep` returns `'permissions'` then `'chromejs'`; Continue disabled while `permissionPending`.

## Design — one reusable gate
`ensureCapability(cap)` (new, `src/main/connection-capability.mjs`), called BEFORE a connection completes:
1. `helper.ensure()` (silent install+launch; no prompt).
2. Check grant: AX/Screen via `helper.status()`; Automation via a benign probe (`requestHelperAutomation`) or just attempt and catch the deny.
3. If missing → emit a **primer** to the island ("To work in your Chrome, allow the next dialog — Blitz acts in your logged-in tabs"), then run the existing request mechanism for that cap (Allow prompt for Automation; drag-to-Settings tile for AX/Screen; the Allow-JS menu step for Chrome).
4. `relaunchForGrant()` if the grant needs a restart to take effect (confirmed for AX/Screen; **verify** whether Automation needs it — if not, skip for a smoother browser path), then re-check.
5. Granted → proceed. Denied → fail the connection gracefully (`ok:false`, a clear "I need permission to control X; enable it in Settings or try again"); the agent already handles `ok:false` (helper-only osa work).

### Trigger wiring
- `conn-connect-tab` (user-chrome/safari) → `ensureCapability('browser:<chrome|safari>')` first.
- `listTabs` of the user's real browser → SAME gate. **Key:** the connect picker must NOT auto-enumerate real-browser tabs on open (that osa would prompt just from opening the panel). Gate tab-listing behind an explicit "Connect my Chrome/Safari" button.
- `os:pick-start` / connect app window → `ensureCapability('accessibility')` (picker needs it), then `'screen'` before the first read/screenshot.
- Blitz Chrome → no gate.

### Agent-initiated connections (act-vs-ask)
Only the user can click Allow / toggle Settings. When the AGENT wants a connection needing a grant, the connect op returns "needs-permission", the island shows the primer + grant moment, the user grants, the op retries. This IS the ask boundary — granting a new capability is a human step.

## Onboarding change
- `nextStep`: after intro → `'done'`. Drop `'permissions'` and `'chromejs'` from the flow (keep the components + IPC; the JIT gate reuses them).
- Keep the helper prewarm at boot (silent). Keep "install Claude Code" (no TCC).
- Net onboarding: intro slides → chat. Zero macOS prompts.

## Files
- `IslandOnboarding.tsx` — `nextStep` → done after intro; the permission/chromejs render branches become JIT-invoked, not flow steps.
- `ConnectPicker.tsx` / `AttachPanel.tsx` — gate real-browser tab-listing behind explicit intent; render the primer card; await the JIT gate before connect.
- `connection-capability.mjs` (new) — `ensureCapability` + the cap→grant map + primer emit.
- `onboarding.ts` — expose `requestHelperAutomation` / drag-grant / `openChromeJs` / `helper.request` as standalone JIT ops (decouple from the onboarding director).
- `index.ts` — connect/pick/list IPC handlers call `ensureCapability` first.
- `computer-use-helper.ts` — already has request/status/relaunch; maybe add an Automation grant probe.

## Empirical test plan
1. Fresh wipe → onboarding = intro → chat. ZERO prompts (TCC log: nothing).
2. Chat + a Blitz Chrome task → ZERO prompts.
3. Open the attach panel → no prompt (no auto tab-list).
4. "Connect my Chrome" → primer → Automation **Allow** (responsible = `dev.blitz.os.computeruse`) → (+ Allow-JS if needed) → tabs list, connect, drive. Reopen later → no re-prompt.
5. "Connect an app window" → primer → Accessibility + Screen Recording (Settings toggle) → connect, read, act. Reconnect → no re-prompt.
6. Deny a grant → connection fails with a clear message, no crash.
7. Every prompt's TCC log responsible process = the helper, never `dev.blitz.os`.

## Open questions / risks (resolve while testing)
- **listTabs auto-prompt** — must gate real-browser enumeration behind explicit intent, else opening the panel prompts. Highest-risk detail.
- **AX/Screen are Settings-toggle grants** (can't inline-Allow), so native-window JIT is the clunkiest path; primer + drag tile must be crystal clear. (Rarest capability, acceptable.)
- **Automation relaunch** — verify if AppleEvents grants take effect immediately (skip relaunch → smoother) or need the helper restart like Screen Recording.
- **Relaunch latency** — `relaunchForGrant` restarts the helper (~1–2s) mid-connect; the gate must wait for reconnect then retry the op.
- **Primer placement** — reuse the drag-helper / chromejs-helper card infra or a new island card; must read clearly above the OS dialog.
