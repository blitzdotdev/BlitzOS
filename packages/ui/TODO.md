# oss/ui — open cockpit

Carve 2026-08-11. Full report: session scratchpad `codex-ui-carve.txt`.
Inventory: ~19.1k LOC TS/TSX/CSS + 15 icon assets. Finding map: 14 UI-lane
findings. 7 die by design. 7 carry as FIX. The closed side imports this cockpit
and wraps it: hosted auth, routes, endpoint resolution. One cockpit, two host
adapters.

## In core (open)

- Cockpit shell: workspace rail, tabs, terminal, ACP chat, files, preview.
- Do NOT port the monoliths. `CloudApp.tsx` (2.0k LOC) and `ChatPanel.tsx`
  (1.8k LOC) split into: workspace reconciler, capability renderer, versioned
  device-local layout controller, ACP controller + reducer, pure views.
- One typed four-call client: create (machine shape + SSH pubkey + optional
  volume ref + optional user-data) · poll · destroy · ssh. No local protocol
  vocabulary. Import the shared `schema` package (2026-08-11) and the official
  ACP schema — ONE pinned ACP SDK version with the box. `protocol.ts` dies.
- Workspace reconciler invariants:
  - Accept a record only when its `revision` is newer.
  - A poll can add, update, and remove rows.
  - Never keep an old endpoint, phase, or capability across a newer view.
- Render the server view. Never infer it. `phase`, `canObserve`,
  `retryAction`, `launchable` come from the API. Error copy is never control
  flow.
- Create flow: explicit submit only. Mount, edit, and cancel perform ZERO
  mutations. One confirmed submit = at most one create request. This is the
  red-first regression test for the dead auto-create family. The form includes
  the volume picker (decided 2026-08-11): same behavior as today's blitzos.com
  picker. The list comes from the `listVolumes` passthrough; core keeps no
  volumes table. No separate volume management page.
- Terminal: ttyd + tmux. Stock `tty` subprotocol framing. Input/resize
  channels. Reconnect, paste, touch UX carry (~1.7k LOC).
- Chat = pure ACP renderer + controller.
  - Calls: session/new, session/load, session/prompt, session/cancel,
    set_mode.
  - Ordered `session/update` rendering. Disconnect ≠ cancel. Reconnect =
    load/replay. Never resend a prompt.
  - Attribution = the authenticated principal. Never a client field.
  - Reducer contract: dedup chunks on replay. Key tool_calls by stable ID with
    kind/status. Render NATIVE diff + terminal content. Render plan updates.
    Answer request_permission at most once; recover it after reconnect. One
    terminal stopReason per turn. Unknown kinds render as a safe generic row.
  - Reducer tests replay the ACP conformance fixtures from `schema` — the same
    stream that gates box image publication (2026-08-11).
- Files: WebDAV browser/editor/upload carries. Server = dufs, loopback 7445
  (founder, 2026-08-11, FINAL). Writes are plain PUT, LAST-WRITE-WINS: dufs
  does not enforce preconditions; the founder accepted the lost-update class
  rather than swap servers. Do NOT add client-side check-then-write — it
  fakes safety the server does not give. Save honesty stays: report the PUT
  result truthfully (the `FileEditor.tsx:305` class).
- Preview panel: iframe + port validation carry. `/chat/ports` discovery is
  dead, permanently (decided 2026-08-11). The user types the port. No
  replacement discovery.
- Standalone bootstrap (decided 2026-08-11; passkeys deleted same day at
  implementation review): login = the operator key, exchanged for an HttpOnly
  opaque session. No passkey, no SSO in core — the principal seam admits
  them later. The key never enters a URL, logs, or browser storage.
- Endpoint resolver seam: the host supplies box URLs. Standalone = tunnel
  ports or the user's own edge. Hosted = closed ingress URLs. Same cockpit
  code in all cases.
- Dependency order: core view/types → box endpoint contract → reducers +
  renderers → hosted wrapper.

## Closed (hosted product wrapper)

- GitHub OAuth identity. Orgs, memberships, roles, rail decorations.
- GitHub App + repository settings. Stripe checkout, claims, seats. Org +
  platform invites. Operator observe page as written.
- Catalog enrichment, pricing, warm-pool copy. Ingress endpoint resolution.
- Closed clients stay out of the four-call client.
- Files in prod: coupled to the ingress `COCKPIT_ORIGIN` promotion (known).

## Deleted (decision in parens)

- `CreateWorkspaceDialog` + all blueprint machinery: auto-create-on-open, the
  blueprint editor overwrite, the `.bashrc` secrets copy (blueprints killed).
  New user-data copy must say: the VM can read user-data; never put secrets in
  it.
- Park/resume/drives UI: parked phases, wake polling, refresh/resume, "box
  asleep" copy (no park/resume).
- The entire bridge wire: start/user/sdk/fatal frames;
  /chat/history|auth|models|capabilities|commands|layout|ports; handoff
  sockets; static provider catalogs + fallbacks (`chat-providers.ts`);
  generation-guard workarounds (ACP).
- BYOM machine settings/registry/offline views (BYOM dead). `/cli-auth` page
  (device flow). Legacy `/api` aliases.
- Client authority derivation: `canControl`, role-derived observe links,
  error-string-matched retry, locally inferred readiness.
- Dead preferences, always-false branches, parked/offline CSS,
  opencode/kimi/pi/prime icons.

## ACP renderer delta (rewrite sizes, not copies)

- Dies: ~1.7–2.0k TS/TSX. Bridge protocol, provider catalogs, history,
  handoff.
- Carries as presentation: ~1.0–1.3k TS/TSX + ~0.8–1.1k CSS. Transcript,
  composer, tool rows, code, permission cards.
- New: ~0.6–0.9k TS/TSX + ~0.1–0.3k CSS. ACP transport, reducer, replay,
  plan/tool/permission states.
- Current chat slice total: ~4.3k.

## FIX carried into the rewrite

12 items. file:line + negative tests are in the full report.

- HIGH `workspace-store.ts:126`: a delayed revision 11 overwrites revision 12.
  Polls cannot discover new rows. Fix: the reconciler invariants above.
- HIGH `api.ts:394` + `CockpitRail.tsx:245`: the client derives authority from
  viewer role. Test: vary only `canObserve`/`launchable`.
- HIGH `CloudApp.tsx:748`: retry driven by error-string matching. Drive it
  from `retryAction` only.
- HIGH `CloudApp.tsx:137`: the endpoint map is append-only. A newer view must
  replace or clear targets.
- `FileEditor.tsx:384` (was HIGH): lost-update class ACCEPTED 2026-08-11.
  dufs kept, last-write-wins, no preconditions, no check-then-write.
- HIGH `FileEditor.tsx:305`: a failed verify still shows "Saved". Distinguish
  committed from verification-unknown.
- HIGH `file-drop.ts:39`: uploads are unbounded. Bound before read.
  (Conditional create dropped with the precondition rule, 2026-08-11.)
- MEDIUM `CloudApp.tsx:480`: a global paste event can lose the delivery
  silently. Use an explicit input sink.
- HIGH `ChatPanel.tsx:834` class: reconnect must converge via replay. Never
  resend a prompt.
- HIGH `ChatPanel.tsx:863`: malformed/unknown frames must not corrupt state.
  Unknown valid kinds render as a generic row.
- HIGH `ChatPanel.tsx:870`: a permission request must survive reconnect. It
  gets one answer, ever.

## Required test: cockpit parity (added 2026-08-11)

The UI carve is complete only when this test passes.

- Take every component on today's main cockpit page. Exclude the settings
  page.
- For each component, exactly one of these must be true:
  1. It exists in the open core with equivalent functionality.
  2. This TODO names it under Deleted.
- One component with neither = the carve is not complete.
- Equivalent functionality = what the user can do, not how the code does it.
  Example: the chat panel counts as present when the ACP renderer gives
  transcript, composer, cancel, and permission answers.
- Checklist source: the surface map + file inventory in `codex-ui-carve.txt`.
  Walk it component by component.
- The walk list from today's cockpit: workspace rail · tabs · terminal ·
  chat panel · files sidebar · file editor · preview panel · create flow
  (the new explicit form replaces the dialog) · confirmation dialog ·
  loading states · error states · header · mobile/touch handling.

## Decided 2026-08-11 (was open questions)

1. Volumes UI: a picker in the create form. Same as today's blitzos.com. No
   separate management page.
2. Observe page: none in the open cockpit, for now. The read-only ttyd
   primitive stays available. Hosted operator observe stays closed.
3. Standalone login: operator key once → opaque session. Passkeys deleted at
   implementation review (2026-08-11): DELETE beat replace-with-SSO. The
   seam admits passkey/SSO later.
4. Hosted composition: hosted imports the open cockpit wholesale and wraps
   it. No fork.
5. Preview discovery: dead, permanently. The user types the port.
6. Layout: device-local only. The simplest. No sync, no server state.
7. Second pass, cross-package synthesis (2026-08-11): the cockpit imports the
   shared `schema` package · reducer tests replay the same ACP fixtures that
   gate box publication · the volume picker reads `listVolumes` (no volumes
   table in core). Front door: `packages/oss/README.md`.

Also resolved: the enums are ratified (control-plane TODO). `phase` =
`creating | ready | destroying | destroyed | error`. `retryAction` =
`poll | destroy | create | null`. `destroyed` is the only terminal. Exhaustive
rendering and tests are unblocked.

No open questions remain.
