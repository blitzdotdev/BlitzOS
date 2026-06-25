# Helper input + workflow PATH fixes

From agent 5's post-mortem (2026-06-24): run_workflow died with `spawn claude ENOENT`, and 5
attempts to type into a Safari Google Doc via a window connection all failed. Replicated + triaged
each against the CURRENT code (the agent ran an older build; the connection refactor landed since).

## Findings (replicated)
- **A. `spawn claude ENOENT` — REAL, current.** A Finder/Dock-launched packaged app inherits launchd's
  truncated PATH (`/usr/bin:/bin:/usr/sbin:/sbin`); `claude` is at `/opt/homebrew/bin`. The blitzscript
  leaf spawner (`blitzscript/agent.mjs _defaultSpawn`) and `capabilities.mjs` invoke bare `'claude'`.
  Repro: `spawnSync('claude', …, {env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin'}})` → ENOENT; absolute path → ok.
- **B. `connection_act` key on a window — REAL, current.** Live: `key:'End'` and `key:'cmd+End'` →
  `"unknown key name"`; `key:'down'` (supported) → ok. `cg_key` (native `main.swift`) is a stub:
  `keyCodes` = return/enter/tab/space/delete/backspace/escape/arrows only — no End/Home/Page/letters,
  and ZERO modifier-combo support. The reported `"no AX element matching [:]"` dispatch symptom is GONE.
- **C. `connection_read {screenshot:true}` — ALREADY FIXED.** Live: returns `{image:<base64 png>,width,height,frame}`.
  The agent's empty `{}` was the old build. Field is `image` (not `png`/`screenshot`).
- **D. Discoverability — REAL.** `connection_act` / `connect_window` descriptions show no per-action param
  shapes or the `cg_key` key vocabulary; agent guessed `keys` vs `key` and `"cmd+End"` wrong.

## Fixes
- [x] **A** — `onboarding.ts`: `ensureFullPath()` resolves the login-shell PATH once and merges it into
  `process.env.PATH`; called from `claudeCliPath()`/`codexCliPath()` (run before any agent → before any
  run_workflow). Closes the whole ENOENT class (claude, enrichment, git, …), not just claude. Verified the
  merge makes `/opt/homebrew/bin/claude` resolvable under the truncated PATH.
- [x] **B** — native `main.swift cgKey`: `keyCodes` expanded (End/Home/Page/ForwardDelete, a–z, 0–9, F1–F12,
  punctuation) and modifier combos parsed (`cmd+`/`shift+`/`alt+`/`ctrl+`/`fn+`) into CGEvent flags. Helper
  rebuilt + re-signed (build exit 0). `key:'cmd+End'`, `key:'cmd+v'`, etc. now resolve.
- [x] **paste** — `connection-window-link.ts` `action:'paste'`: Electron `clipboard.writeText(text)` (if given)
  then `cg_key 'cmd+v'`. Sidesteps per-char cg_type + AX; the clean way to drop a block of text into a canvas.
- [x] **D** — `os-tools.mjs`: `connection_act` description now has one example per action + the key vocabulary
  + `paste`; `connection_read` documents the screenshot `{image,width,height,frame}` shape; `connect_window`
  points at the act vocab. Typecheck clean (my files).
- C: no fix; optionally document the `image` field (folded into D).

## Doctrine (separate, committed cb49bbb)
`blitzos-agents.md` already steers canvas-app typing to the official API or the helper window and forbids
self-synthesized OS keystrokes. Right direction, but it points at the helper path B must finish.
