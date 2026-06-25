# BlitzOS — cross-agent chat context leak (fix)

## The bug (proven on disk, 2026-06-25)
A spawned agent absorbed ANOTHER agent's task. New Agent (id 1) was asked "find Eventbrite
producers" but replied "highlight the top 3 issues in the BlitzOS Testing Log" — Blitz '0's task.

Root cause, from New Agent's own session jsonl (`e097e1cc…`):
1. `tail chat-1.md` + `/events` → its own file, empty.
2. `ls "$workspace"/*.md` → exposed every sibling transcript in the shared workspace ROOT.
3. `cat .../chat.md` → read Blitz '0's transcript, swallowed its task, ran with it.

Two compounding vectors:
- **Stumble read** — a fresh agent told to "recover the conversation / you may have been
  restarted" finds its own chat empty, sees `chat.md` in the root, reads it.
- **Auto re-injection** — once read, Claude Code auto-attaches `chat.md` (edited_text_file) on
  every later edit, so every new Blitz message keeps getting force-fed in. The agent can't opt
  out, so a prompt rule alone can't stop this — the file must never be readable in the first place.

Earlier "bleed fix" pinned agents per WORKSPACE; this is a different axis (sibling agents WITHIN
one workspace). That's why it "still leaks".

## The fix (structural isolation)
1. **Relocate transcripts out of the shared root** into a private per-agent dir, behind the single
   `chatFileName()` chokepoint: `chat.md`/`chat-N.md` → `.blitzos/agents/<id>/chat.md`. The root
   now exposes no sibling chats; `.blitzos` is OS-internal (agents are told not to touch it, the
   file manager refuses to descend). Kills the stumble read AND, by never being read, the
   auto-reinjection.
2. **One-time migration** `relocateLegacyChats(dir)` runs at workspace-open (hydrateOnBoot +
   performSwitch) AND defensively at the top of every `prepareAgentLaunch` — so no agent process
   ever starts against a root-resident transcript. Idempotent, history-preserving.
3. **Bootstrap hardening** (defense in depth): gate the "you may have been restarted / recover the
   conversation" lure to REAL resumes only (fresh spawns just read their own file for the task);
   add a hard rule: only ever read your own `chatFile`, never another agent's conversation.

## Files
- `src/main/workspace.mjs` — `chatFileName()` → private path; `relocateLegacyChats()`; rm empty
  agent dir on close. (`atomicWrite` already mkdirs the parent.)
- `src/main/agent-runtime.mjs` — `buildBootstrap(resume)` (recover gated + isolation rule); chatFile
  via `chatFileName()`; call `relocateLegacyChats` in `prepareAgentLaunch`.
- `src/main/workspace-host.mjs` — call `relocateLegacyChats` before `migrateChatToFile` (boot+switch).
- `*.d.mts` (workspace, agent-runtime) + tests (test-chat-transcript, test-folder-host) → chatFileName.
- Docs: agent-os/CLAUDE.md persistence note (transcripts now private, not workspace-root).

## Verify
- `npm run check` green.
- `node scripts/tests/test-chat-isolation.mjs` (24 checks) — locks: private per-agent path, no
  malformed-id collision onto '0', traversal-safe, root exposes no sibling, migration history-intact +
  non-destructive, bootstrap lure gated + isolation rule present.

## Adversarial review (3 agents: logic / TCC / isolation-completeness)
- **TCC: SAFE.** Pure node `fs`, only ever enumerates `~/Blitz/<safeName>` (safeName-jailed, realpath-
  checked, not a TCC-protected dir). No native/AppleEvent/child-process/`systemPreferences` introduced;
  nothing that should go through the Swift helper. (Only theoretical prompt path is the pre-existing
  `BLITZ_WORKSPACES_ROOT` env override — not new, governs the whole host already.)
- **Isolation: FULLY CLOSED, no regressions.** Every transcript read/write routes through `chatFileName()`
  (renderer via IPC, index.ts tail, server backend, attachment-store all id-keyed); `.blitzos` is
  unscannable so the new path can't surface as a tile; served `blitzos-agents.md` no longer nudges a root read.
- **Logic: 2 MED findings, both FIXED:**
  1. `chatFileName` fell back to `'0'` for a malformed id → a relay agent passing `agent:"0 "`/`"1.5"` on
     say/steer (unconstrained string) wrote into the PRIMARY's chat (a new write-into-0 leak). Fixed: a
     malformed id now gets a jailed, collision-resistant `x-<hex>` bucket; empty still maps to '0'.
  2. Migration's dest-exists branch unconditionally `unlink`ed the root copy, and a stray `chat-0.md`
     raced `chat.md` for id 0. Fixed: skip `chat-0.md`; dest-exists moves the root copy ASIDE
     (`chat.legacy-<rand>.md`) inside the private dir instead of deleting — non-destructive.
- Non-blocking (not fixed, out of scope): doctrine line 31's "keep notes in a root .md" is intended
  SHARED user-memory (not a per-agent chat); stale workflow-example path strings are dead artifacts; no
  test is wired into `npm run check` (consistent with all sibling tests — run manually).
