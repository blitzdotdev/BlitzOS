export const meta = {
  name: 'build-w2-tick-diff-steer',
  description: 'Build + headless-test W2: the host-side tick -> diff -> steer supervisor heartbeat (Option A)',
  phases: [
    { title: 'Implement', detail: 'one Opus agent reads perception-core + implements emitTick/setTickSource + /steer' },
    { title: 'Test', detail: 'headless node test of the differ + materiality + steer, + typecheck' },
    { title: 'Verify', detail: 'adversarial review for hacks / layering / breakage' },
  ],
}

const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'
const COMMON = `Repo: ${ROOT}. Git branch blitzos-journey-build (the Job model slice just merged: src/main/job-model.mjs exists). READ the ACTUAL current code before editing (do not work from memory). NO hacks: if a piece can't be done cleanly, leave a precise TODO + say so (never fake/claim-done). Do NOT touch the renderer (src/renderer/**) or the user's uncommitted WIP (App.tsx, store.ts, components/PrimarySpace.tsx, styles.css) — W2 is HOST-side (main + the shared perception kernel). Cite file:line.`

phase('Implement')
log('Building W2: emitTick + setTickSource seam + the host differ + /steer (Option A, host-side)')

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['filesChanged', 'newFiles', 'typecheckPass', 'todos', 'summary'],
  properties: {
    filesChanged: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'what'], properties: { path: { type: 'string' }, what: { type: 'string' } } } },
    newFiles: { type: 'array', items: { type: 'string' } },
    typecheckPass: { type: 'boolean' },
    typecheckOutput: { type: 'string' },
    todos: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const impl = await agent(`${COMMON}

Build W2 (E2): the host-side TICK -> DIFF -> STEER supervisor heartbeat. FIRST read plans/blitzos-tick-diff-steer.md (the spec) + plans/blitzos-user-journey.md. SCOPE THIS SLICE to the HOST-side logic only: the tick emitter + the diff over agent/terminal/surface state + the steer call-site. Do NOT build the P0 in-iframe content-snapshot reporter (a later renderer slice) — but DO diff each surface's \`props\` that are ALREADY in os:state (cooperative widgets like a plan widget already setProps their content into props, which is host-readable in \`cached\`).

OPTION A is load-bearing: BlitzOS only ticks, diffs, and EMITS the material diff as a perception moment. The AGENT owns all steering judgment — ZERO per-task/stuck/threshold heuristics in the OS. Materiality is content-agnostic transition-shape only.

READ these real files: src/main/perception-core.mjs (the WHOLE file — setWorkspaceProvider :41 and setMomentTap :166 are the registration-seam pattern to MIRROR; the emit() funnel :173; flushCanvas :264 + ingestCanvasOps as the coalesced-emitter template; the sweepTimer :294; visibleTo :52-60 — a trigger:'tick' moment with NO agentId already falls through to '0'; redactMoment :83; the materiality early-return \`if(!p.hasUser) return\` :213; emitUserMessage :341), src/main/events.ts (it re-exports perception-core — make sure new exports flow through), src/main/osActions.ts (osGetState :1021 returns \`cached\` incl. surface props; diffCanvasOps :663 geometry-only diff + its consumeEcho/canvasBulkAt echo+bulk suppression; osUserMessage :815), src/main/workspace-host.mjs (setChatStatus :462 / noteAgentActivity :480 writers; the chatStatus reader :472 is NOT exported on the public API — you must export a snapshot), src/main/workspace-host.d.mts (the host's public API type), src/main/terminal-manager.mjs (listTerminals -> per-agent status/exitCode), src/main/os-tools.mjs (how a tool is defined; the /say tool ~:576), src/main/electron-os-tools.ts + preview/backend.mjs (op binding + provider wiring, both transports).

IMPLEMENT (handle edge cases):
1. perception-core.mjs: add \`let tickSource=null; export function setTickSource(fn){...}\` (mirror setWorkspaceProvider) and \`export function emitTick(){...}\`. emitTick: call tickSource() to get the host snapshot {agentStatus:{id->status}, terminals:[{id,status,exitCode?}], surfaces:[{id,kind,x,y,w,h,props?}], workspace?}, DIFF it against a module-level lastTickSnapshot, and emit ONE moment {trigger:'tick', surfaceId:'desktop', signals, user:[human lines], diff} ONLY when the diff is MATERIAL — else update lastTickSnapshot and RETURN with no emit (mirror the \`if(!p.hasUser) return\` discipline so a quiet desktop never wakes the supervisor). Funnel through emit() so it inherits ring-cap + waiter-wake + workspace-stamp. Drive emitTick from the EXISTING sweepTimer :294 gated to a TICK_MS sub-cadence (a const, ~10000ms) — do NOT add a second always-on interval; keep it unref'd-safe.
2. Materiality (content-agnostic, transition-shape only): agent status working->{waiting,stopped,error} and *->error are material; working->working / working->watching / ramp-up (starting->working) are NOT. Terminal exit (a new exitCode) is material. An agent added/closed (id appears/disappears) is material. A surface opened/closed is material. A surface whose \`props\` changed (deep-unequal vs prior tick) is material (a widget was edited). Pure geometry move/resize is NOT material for the tick (geometry already rides the existing 'canvas' moment — don't double-wake). EMPTY/immaterial diff => no emit.
3. redactMoment :83: add a branch so trigger:'tick' crosses the relay as metadata — the tick carries agent statuses + "surface X edited" flags + counts (consent-safe OS metadata), NOT scraped page content. Do not ship raw edited surface CONTENT over the relay in this slice (carry only the changed surface IDs + a short label; the supervisor pulls full content via get_surface). Mirror the message/connector pass-through shape.
4. Self-reaction guard: reuse the canvasBulkAt/bulk-suppression idea — a tick fired right after a tool op or a workspace switch must not read tool-origin churn as a spurious user/agent change. At minimum, skip emitting a tick whose only deltas coincide with a just-applied bulk transaction (osActions canvasBulkAt window).
5. workspace-host.mjs: export a \`chatStatusSnapshot()\` (id->status map, built from the existing chatStatuses the writers maintain) on the host's public API + its type in workspace-host.d.mts.
6. osActions.ts (+ index.ts wiring): register the tick provider via setTickSource(() => ({ surfaces: osGetState().surfaces, agentStatus: <wsHost.chatStatusSnapshot()>, terminals: <terminal status map>, workspace: <active> })). Add a thin osAgentStatus() if helpful. Wire it once at bootstrap (parity with setWorkspaceProvider wiring). Do the SAME in preview/backend.mjs for server parity.
7. os-tools.mjs: add a \`/steer {agent, text}\` tool (sibling of /say) -> ops.steer -> osUserMessage/emitUserMessage into agent N's chat (wakes ONLY N). NOTE the verified fact: /say does NOT wake the target (it's agent->user); only osUserMessage/emitUserMessage wakes a specific agent, and /user_say is localhost-only. So /steer must map to the userMessage/emitUserMessage path, relay-safe. Bind ops.steer in electron-os-tools.ts (electronOps) + preview/backend.mjs (serverOps).

Run \`npm run typecheck\` and fix all NEW errors. Report filesChanged, newFiles, typecheckPass, and every TODO.`, { label: 'implement', phase: 'Implement', schema: IMPL_SCHEMA })

phase('Test')
log('Headless test of emitTick / materiality / steer + typecheck')
const TEST_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['testFile', 'ran', 'pass', 'typecheckPass', 'output'],
  properties: { testFile: { type: 'string' }, ran: { type: 'boolean' }, pass: { type: 'boolean' }, typecheckPass: { type: 'boolean' }, output: { type: 'string' }, notes: { type: 'string' } },
}
const test = await agent(`${COMMON}

W2 was just implemented (perception-core.mjs emitTick/setTickSource, redactMoment tick branch, workspace-host chatStatusSnapshot, osActions/backend provider wiring, a /steer tool). Implementer summary: ${JSON.stringify(impl?.summary || '').slice(0, 900)}

WRITE scripts/test-tick-diff.mjs (Node ESM; FIRST read scripts/test-job-model.mjs and an existing perception test like scripts/test-perception-scope.mjs if present, for conventions + how to drive perception-core in isolation). Test REAL behavior against perception-core directly:
- setTickSource registers a provider; emitTick with a provider whose snapshot CHANGED materially (e.g. an agent working->stopped, or a terminal exitCode appears, or a surface's props changed) EMITS exactly one trigger:'tick' moment, and waitForEvents('0') receives it (visible to the primary supervisor).
- emitTick with NO material change (same snapshot, or only working->working / a pure geometry move) emits NOTHING (the empty-diff early-return) — assert latestSeq() did not advance.
- materiality: working->stopped emits; working->working does not; a surface props change emits; a pure x/y move does not.
- redactMoment(tickMoment) keeps the diff metadata (passes the relay) and carries no scraped page content.
- the /steer path: invoking the steer op (or osUserMessage) for agent 'N' emits a private trigger:'message' visible ONLY to 'N' (not '0').
Run \`node scripts/test-tick-diff.mjs\` and \`npm run typecheck\`. Also re-run any existing perception test to confirm no regression. Return ACTUAL output + honest pass/fail.`, { label: 'test', phase: 'Test', schema: TEST_SCHEMA })

phase('Verify')
log('Adversarial review of the W2 diff')
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'issues', 'breaksExisting', 'hacksFound'],
  properties: {
    verdict: { type: 'string', enum: ['clean', 'needs-fixes', 'broken'] },
    breaksExisting: { type: 'boolean' }, hacksFound: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'file', 'problem', 'fix'], properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } },
  },
}
const verify = await agent(`${COMMON}

ADVERSARIALLY review the W2 implementation on this branch. Run \`git diff 671e355 -- src/main preview scripts\` + \`git status\`, read the changed files, and run \`npm run typecheck\` yourself. Be skeptical; assume corners were cut. Check:
1. LAYERING: perception-core.mjs must NOT import osActions/workspace-host (it's the shared kernel; server imports it too). The host state must arrive ONLY via the setTickSource provider. A direct import is a blocker.
2. Option A: is there ANY per-task / "stuck" / threshold heuristic in the OS differ? There must be none — only content-agnostic transition-shape materiality. Flag any task-specific logic.
3. SPAM: does an immaterial tick truly early-return with NO emit (a quiet desktop = zero tick moments)? Does a pure geometry move avoid double-waking (it already rides 'canvas')? Is the self-reaction/bulk guard real?
4. The /steer tool: does it ACTUALLY wake the target agent? (/say does NOT wake — only osUserMessage/emitUserMessage does. If /steer maps to /say or a non-waking path, it's broken.) Is it relay-safe?
5. redactMoment: does a tick cross the relay WITHOUT leaking scraped surface CONTENT? (metadata + changed-ids only.)
6. Does it break existing perception (the canvas/message/idle moment paths, the existing tests)? Run them.
7. Type errors. Return concrete issues (severity + file + problem + fix) + a verdict.`, { label: 'verify', phase: 'Verify', schema: VERIFY_SCHEMA })

return { impl, test, verify }