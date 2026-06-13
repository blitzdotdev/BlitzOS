# Onboarding v2 — "Case File: You" (the board that learns you)

**Status:** Design agreed 2026-06-10 (forks ratified in session). **P1 shipped 2026-06-10** — scan `--json`/`--progress`, five template widgets (profile/rhythm/toolbox/quotes/gaps), director (`src/main/onboarding.ts` + pure planner `onboarding-board.mjs`), Dia-like opener with real progress + dissolve, native `unlock` FDA card with poll→rescan→deepen. Verified live (board seeded from a real scan, FDA-granted path; locked→grant path unit-tested, not yet exercised live — this dev machine already grants Electron FDA). Test: `node scripts/test-onboarding-seed.mjs`. P2 (resident brain) next.
**Companions:** `guardian-angel-blitzos.md` + `guardian-angel-gwern.md` (**the frame this lives inside** — onboarding is the GA's first hour; the interview = Gwern's active-learning elicitation; the case file = `PRINCIPAL.md` made spatial; originating work = his daydreaming rule), `ONBOARDING-FLOW.md` (the existing CLI scan+interview — stays valid, this builds the in-OS experience on top of it), `blitzos-folders-memory.md` (the persistent workspace this flow leaves behind), `confidential-ai-gateway.md` (the eventual home of the hosted-inference fallback; v1 ships the honest plain-disclosure form), `agent-os-design-system.md`.

## Goal

**Onboarding is not a separate experience from using BlitzOS.** It is the user's first look at a resident, autonomous, genius agent whose standing job is to learn everything about them and become hyperaligned — and what they watch during "onboarding" is simply what that agent's autonomy looks like when its model of you is empty: its highest-value actions are learning-you actions. There is no wizard that ends and hands over to "the real product"; the same agent, same loop, same board continue forever, with the initiative mix shifting from *eliciting* → *executing* → *originating* (see "The initiative gradient"). Doing assigned work is table stakes; the bar is an agent that **thinks of new things to do** that advance whatever the user cares about.

Concretely, first launch turns the scan + interview that already exist (`scripts/onboarding-scan.mjs` + `src/main/blitzos-onboarding.md`) into a **magical, alive, collaborative** on-canvas experience: the agent visibly builds its understanding of the user as a spatial "case file" board the user can correct, annotate, and feed — and that board persists as the agent's living model of the user. Aesthetic target: Dia's warmth and pacing, dissolving into the BlitzOS canvas (the canvas is the product; full-screen ends early). Theming is *light* detective-investigation: copy + spatial arrangement only — no polaroid/red-string props in v1.

## Ratified decisions (2026-06-10)

1. **Brain = built-in loop.** BlitzOS main runs the interviewer itself: a small agent loop (model call → tool dispatch → repeat) with tools dispatched **in-process** through the existing `os-tools.mjs` registry (`electronOps`) — no relay, no paste-a-URL before the user has seen the product. Model backend is swappable: local `claude` CLI when detected (reuse the agent-launch pattern — `agent-runtime.mjs` + `terminal-manager.mjs`, a VISIBLE `claude` tmux terminal), else **our hosted gateway**.
2. **Gateway gets the full scan, plainly disclosed.** When no local AI exists, the same scan a local brain would read goes to the gateway, behind one plain-language disclosure card at the fork ("this summary goes to Blitz servers to run your interview"). No silent uploads, no blurred copy. The confidential-TEE gateway later upgrades the *guarantee*, not the UX.
3. **The board persists.** The onboarding workspace ("Case File: *<name>*") is a permanent, folder-backed workspace — the OS's editable model of the user, which the daily agent keeps updating. Onboarding is the first session of an ongoing relationship, re-openable to correct the OS anytime.
4. **Restyle via wardrobe card.** Style inference (accent / wallpaper / density from the user's inferred taste) is **proposed, never silently applied**: a tap-to-try card; keep or revert.
5. **One brain, no finale.** The onboarding interviewer **is** the resident agent (guardian-angel v1), not a disposable wizard brain — one loop, one policy prompt, with `blitzos-onboarding.md` as its *elicitation phase*, not a one-shot script. Onboarding never "ends": the agent keeps interviewing opportunistically forever (one highest-information question at the right moment, Gwern's rule — measured by how much the answer would change the case file), while its initiative mix tips toward executing and originating as the model of the user saturates.

## The experience — five beats

1. **Boot (full-screen, ~10s, Dia-warm).** Animated warm gradient + breathing wordmark over the frosted wallpaper (upgrade of the existing `OnboardingFlow.tsx` boot). Progress is **real**: the scan streams stage lines over IPC ("reading your coding sessions… 41 projects found"), replacing the fake 2.8s timer. Then the overlay **dissolves into the canvas** — the signature transition.
2. **The board assembles (deterministic — zero LLM dependency).** A fresh `Case File` workspace fills with library widgets animating in, seeded straight from scan JSON: project dossier grid (`widgets/dossiers.html` — already a scored-entity-card grid), cadence/timeline card, people card, voice-samples note, tooling card, and a "gaps" card with visible empty slots (what the OS *doesn't* know yet — the interview's table of contents).
3. **FDA as the tutorial unlock.** An action-item card (existing inbox, kind `signin`/`task`): "Blitz can only see your work footprint. Unlock the personal layer?" → button deep-links `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`; main polls `hasFDA()` (already in the scan script — lift it); on grant: celebrate + **visibly deepen** — rescan Branch A and drop in new cards (Messages cadence, Safari clusters, app-usage rhythm). Declining is fine; the Branch-B board stands. Granting a permission = unlocking a level, with an immediate, visible reward.
4. **The interview, on the board.** The built-in interviewer (prompted by `blitzos-onboarding.md`, ≤4 tailored MC questions + 1 open voice sample) asks via chat `blitz-ui` MC cards, each optionally **annotation-pinned** next to the evidence it's about (item 5b layer). Every correction path **already wakes the agent**: widget-card interactions (`__blitz` postMessage → `App.tsx` → `os:surface-action` → moment), annotations (`os:annotate`), chat, and content-share toggles on web surfaces the user opens as evidence (their portfolio, Twitter — `setContentShare` + `read_window`). The agent visibly revises the board after each signal: cards update, scores shift, wrong cards get struck and replaced.
5. **The gradient tips (no finale).** The wardrobe card and the "What I learned" centerpiece are not a closing ceremony — they are the agent's **first proactive acts**, the moment the user watches it cross from asking into doing-and-proposing. The workspace persists, the same agent stays resident, and the choreography simply stops being scripted: from here the agent's behavior is governed by the initiative gradient below.

## The web-first life (added 2026-06-10; partially shipped)

The scan's Branch B skews engineer (shell/git/editors/agent histories). Two correctives:

**Shipped in P1 (scan v2 + adaptive board):**
- New sources: **Calendar** (upcoming, meeting density, attendees→people), **Contacts join** (Messages/Mail/Calendar handles → "First L." names via local AddressBook; unmatched handles stay hashed), **document census** (mdfind counts — what this person *makes*; zero permissions), **doc authors** (kMDItemAuthors → people), and **web-first detection**: `scan.web = { webFirst, visits, devSignals, workflow[] }` where `workflow` matches browsing against a curated SaaS map (Gmail, Notion, Slack, Figma, Jira… with `integration` set when a BlitzOS OAuth provider exists).
- **Adaptive slots** (`onboarding-board.mjs`): fixed cards own their slots; flex slots (hero B, F, I) are assigned by what the scan found. A web-first scan puts the **Workflows card in the hero slot** (projects yields); meeting-heavy gets the Schedule card; FDA-off reserves slot I for the unlock card. The Workflows widget rows have one-click **Open** (spawns the site as a live web surface via `blitz.tool open_window`) and a `connectable` badge where an OAuth provider exists.

**P2 — the brain's import conversation (the Dia move, not yet built):** when `webFirst` is true, the resident agent's elicitation phase includes an explicit offer: *"most of your life is in the browser — want me to bring it in?"* Concretely, in escalating order, each a separate consent: (1) history/bookmarks are already in the scan — it narrates what it learned; (2) **open-tabs import** — AppleScript to Chrome behind the **Automation (AppleEvents) TCC prompt**, staged as a second tutorial-unlock moment like FDA (button → prompt → tabs become live surfaces / a saved board); (3) **open each core workflow site as a live surface** and let the human sign in once (the `persist:agentos` session keeps it); (4) **file action-items to connect OAuth integrations** for the detected `integration` sites (gmail/github/slack/jira/discord exist today) so the agent can act, not just look. Accept/dismiss of each lands in the case file (the autonomy dial in practice). Open spike: Automation-prompt attribution in dev (Electron binary, same caveat as FDA spike 1).

## Not a flow — the initiative gradient

The same wake loop (`/events` moments) runs from first boot forever; what changes is the **initiative mix**, weighted by how confident the agent's model of the user is:

- **Elicit** (model thin — dominates hour one): scan, board-building, the ≤4-question interview, FDA unlock. Afterward, elicitation never stops but becomes *opportunistic and rationed*: one question, annotation-pinned to live evidence, only when its expected case-file delta is high.
- **Execute** (model forming): do the work the user asks for, in their voice, scoped by their act-vs-ask answer. Table stakes.
- **Originate** (model rich — the actual bar): in spare initiative (idle moments, Gwern's "if it's sitting idle, something has gone wrong"), the agent consults the case file's goals + recent perception and **proposes work the user didn't ask for**: a speculative draft, a research board, a "you said X matters — here are three moves" card. Proposals land as **action-items / quiet surfaces, never modals**; accept / edit / dismiss are each feedback that updates the case file (DAgger-style convergence).

**What stays OS-enforced rails (everything else is agent policy):** write-confirm on outward actions + STOP, proposals-go-to-inbox attention etiquette, and the case file as the durable medium. The proactivity dial itself is set by the user's own act-vs-ask interview answer and revisable on the board.

## Reliability spine

- **Three degradation tiers, no tier errors out:**
  1. Full magic — LLM interviewer (local CLI or gateway).
  2. No model reachable — deterministic board still assembles from scan JSON, but no fake interview runs; the chat says the real interviewer is unavailable.
  3. Scan fails / non-macOS — straight to desktop, onboarding marked incomplete and re-offerable.
- **Deterministic structure, LLM soul.** The LLM never authors raw per-card HTML in v1 — it drives library widgets via `update_surface{props}` (arrangement, titles, hypotheses, question text). At most ONE bespoke srcdoc centerpiece (the case-file header) for flair.
- **Effects verified.** All board mutations ride the existing effect-verified syscalls + durable workspace flush, so the board survives a crash mid-onboarding and resumes (journal says onboarding-in-progress → reopen the Case File workspace, re-offer the next beat).

## Build inventory (new code, sized)

| Piece | Where | Size |
|---|---|---|
| `--json` output mode for the scan (expose the internal `ctx` buckets; markdown render unchanged) | `scripts/onboarding-scan.mjs` | S |
| Scan progress events (stage lines) over IPC to the boot screen | scan + `src/main` + `OnboardingFlow.tsx` | S |
| FDA unlock: poll `hasFDA()` from main, settings deeplink, rescan-on-grant | `src/main` (+ action-item card) | S |
| **Resident brain loop (GA v1)**: model-call→tool-dispatch loop in main; backends = `claude` CLI / gateway HTTP; tools = in-process `os-tools` handlers; policy prompt = GA mandate with `blitzos-onboarding.md` as its elicitation phase + scan | new `src/main/resident-brain.mjs` (shared-core style) | M |
| **Gateway worker**: minimal hosted endpoint (blitz.dev infra, CF Worker), our key, per-install rate limit, tool-calling passthrough | separate repo/worker | M |
| Disclosure card (gateway fork) + tier copy | renderer | S |
| Deterministic board seeding: scan JSON → workspace + widget props layout | main (uses existing create/spawn ops) | M |
| Editable case-file card variant: dossier-style card whose fields fire `blitz.action {type:'correct', field, value}` | one new library widget | S–M |
| Note-edit moment (gap: native `NoteWidget` edits emit nothing today; srcdoc widget edits DO wake) — emit an `edit` moment from the note-props update path | main perception seam | S |
| Wardrobe card + apply/revert (accent/wallpaper/density) | widget + `wallpaper.ts` hooks | S–M |
| Boot dissolve-to-canvas transition + warm gradient | renderer CSS/flow | S–M |
| Onboarding state machine: `first-launch` gating (existing `config.ts`), resume-after-crash, re-run from Case File workspace | renderer + journal | S |

## Phasing

- **P1 — the board, no mind.** Scan `--json` + real boot progress + dissolve + deterministic Case File assembly + FDA unlock loop + persistence. Shippable and already feels good; zero LLM dependency.
- **P2 — the resident brain, v1 (its first behavior is the interview).** The GA loop (CLI backend first, gateway second) + disclosure card + questions-on-the-board + live revision loop. The brain does not exit after the interview — it stays resident on the wake loop.
- **P3 — the gradient.** Wardrobe card, editable-card polish, annotation-pinned questions, opportunistic-elicitation etiquette, and the **originate** mode: spare-initiative proposals via action-items + speculative surfaces, with disposition-as-feedback into the case file.

## Pre-board permission sequence — SHIPPED 2026-06-12 (the Codex drag)

Built per the TODO below: a Dia-style step sequence INSIDE the opener, before the scan ever runs
(`PreboardSteps` in `OnboardingFlow.tsx`; phase `'steps' → 'boot'`), so every grant lands before
there is board state to lose and the FIRST scan already runs Branch A.

- **The Codex move, reverse-engineered from Codex.app** (`system-permissions-service` in their
  asar): System Settings permission lists accept a DROPPED .app bundle, so the app icon is a
  NATIVE drag source — renderer `dragstart` → `preventDefault()` → IPC → main
  `e.sender.startDrag({ file: appBundlePath(), icon: app.getFileIcon(...) })`. Dev drags
  Electron.app (the binary TCC actually attributes to), packaged drags BlitzOS.app. Icon for the
  tile: sips-converted bundle .icns (Codex's trick), `getFileIcon` fallback.
- **Steps:** FDA (open-settings deep link + the drag tile + 1.2s grant polling → celebrate →
  auto-advance; skippable — the board's unlock card stays the re-offer) and **browser import**
  (detected chromium-family browser; "Connect" fires a one-line AppleScript via osascript, which
  RAISES the Automation consent prompt attributed to the app and resolves after the user answers,
  returning live window/tab counts as the visible reward). No browser installed → step hidden.
- **Persistence:** outcomes in `userData/preboard.json` (machine-level, pre-workspace) — settled
  steps never re-ask across launches even in `ONBOARDING_MODE 'always'`. To re-test: delete that
  file; reset consents with `tccutil reset SystemPolicyAllFiles` / `tccutil reset AppleEvents`.
- **The unlock card** gained the same drag tile (consistent gesture on the re-offer path).
- **Open:** live-verify Automation prompt attribution in dev (Electron) vs packaged (spike 1's
  twin); screen-recording/accessibility steps slot in trivially when a feature needs them (the
  relaunch-class grants this TODO worried about — BlitzOS uses neither yet, so the sequence ships
  without them rather than asking for unused power).

**Color pass (2026-06-12, same session):** the accent is live Blitz red `#e31c30`, NOT the
design-system's stale coral — and the primary is not fixed, so onboarding reads `--accent`
everywhere (preboard primary/dots, boot bar, unlock CTA + drag tile), zero hardcoded accent hex
(only `#fff` ink on the accent button, matching app convention). Board per-role accents stay as
ratified; all accent/ink pairs verified WCAG AA-text ≥4.5 (dusty 6.06, sage 6.33, marker 9.34),
slate nudged `#5B78AA`→`#5874A4` (was 4.46, a hair under; imperceptible darken → 4.72).
Design-system doc corrected (accent table now reflects red + the not-fixed rule).

## TODO (user, 2026-06-11): frontload quit-and-relaunch permissions in a Dia-style pre-board screen

Permission grants that force BlitzOS to QUIT AND RESTART (TCC grants that only apply on relaunch —
screen recording, accessibility/automation; FDA's rescan is live but its Settings round-trip belongs
with them) must NOT live mid-experience as board cards: a restart mid-board kills the magic and the
cached-board re-entry papers over it. Move them to the FRONT — a traditional, Dia-inspired onboarding
screen (full-screen, warm, one permission per step with the why + a single button) BEFORE the scan/
dissolve, so every restart happens before the user has any board state to lose. The unlock-card flow
stays only for grants that apply live. (Dia's own onboarding does exactly this: permissions first,
product second.)

## Open spikes (resolve during P1/P2, none block starting)

1. **TCC attribution in dev:** FDA grants attach to the responsible process — packaged `BlitzOS.app` is clean, but `npm run dev` runs Electron's binary; verify the scan child-process inherits the right TCC identity in both, and what the Settings pane shows the user to enable. (The CLI doc's "grant your terminal" guidance does not transfer.)
2. **Scan runtime:** measure real Branch B and A+B wall-clock (it shells out heavily — `mdfind`, sqlite copies) so the boot beat is paced to truth, and decide what runs pre- vs post-dissolve.
3. **Gateway concretes:** the interviewer runs the **smartest available model** (Opus/Fable-class) — onboarding is once-per-user, so cost amortizes to ~nothing against lifetime value, and the "it gets me" vs. horoscope-slop gap is almost purely model quality; the first interview is the hardest, highest-leverage inference of the product's life. (Decided 2026-06-10 — do not quietly downgrade for cost.) Remaining opens: per-install identity for rate limiting, where the worker lives in blitz.dev infra, and tool-calling shape: OpenAI/Anthropic-compatible messages with tools, or a purpose-built `/interview` endpoint that hides the loop server-side.
4. **`claude` CLI detection:** detect + verify it's authed (a 1-token probe) before choosing the local backend, else the "local" path fails mid-magic.
5. **Editable-card protocol:** the exact `blitz.action` correction envelope (`{type:'correct'|'add'|'strike', cardId, field, value}`) so the interviewer's revision behavior is deterministic to test.
6. **The cost of resident genius (needs an explicit decision, not a quiet default):** the once-per-user amortization argument covers the *interview*; a smartest-model brain that stays resident on the wake loop is a continuous burn. Options: (a) accept the burn for v1 testers (simplest, honest), (b) tiered escalation — a cheap model watches moments and escalates to the genius model on significance (legitimate architecture, but the cheap watcher's significance-misses are exactly the failures that make a GA feel dumb), (c) genius for elicit/originate turns, cheap for mechanical execute turns. Don't pick silently — this shapes the product's economics (BlitzCloud autonomy upsell).
7. **Proactivity budget:** how many unsolicited proposals per day before "originate" reads as noise; default conservative, dial set by the user's act-vs-ask answer and revisable on the board.

## Test plan (repo convention: `scripts/test-*.mjs`, no display needed)

- `test-onboarding-seed.mjs`: scan JSON fixture → board seeding → assert workspace.json nodes (cards, layout, ids) without any model.
- Agent-launch regression (`test-agent-fresh.mjs`): pending interview duty launches primary agent 0 with standard-context `sonnet`, low effort, and the boot task injected.
- `test-fda-unlock.mjs`: `hasFDA()` override flags → assert rescan trigger + card deepening path.
- Degradation: no `claude` CLI → show an explicit "real interviewer unavailable" chat error; do not run a canned interview.

---

## Work log — what shipped (2026-06-10)

**P1 complete + the scan-v2/adaptive slice + the feedback round.** All verified live on the dev machine (board seeded from a real scan; `npm run check` + `node scripts/test-onboarding-seed.mjs` green, 45 assertions).

- **Scan** (`scripts/onboarding-scan.mjs`): `--json PATH|-` (structured distilled view, same redaction/caps as the markdown) + `--progress` (`@progress {json}` stage lines on stderr). New sources: **Calendar** (upcoming/meeting-density/attendees, CalendarStore schema in the group container), **Contacts join** (AddressBook → "First L." names for Messages/Mail/Calendar handles; unmatched stay hashed), **document census** (mdfind counts, zero permissions), **doc authors** (kMDItemAuthors→people), **web-first detection** (`web.webFirst` + curated `workflow[]` SaaS map w/ brand `color` + `integration` ids). `identity.name` = human name (possessive ComputerName → `id -F` → git), `identity.handle` = git name. People carry `via` (commits/messages/mail/meetings/documents).
- **Template widgets** (`widgets/`, manifest-registered): `profile`, `rhythm` (week×hour punchcard, cool→warm `heatLo→heatHi` ramp), `toolbox` (library-only — its board card was cut), `quotes`, `gaps`, `workflows` (favicon w/ brand-color letter fallback; Open → `blitz.tool open_window`; `connectable` badge).
- **Director** (`src/main/onboarding.ts`, impure) + **pure planner** (`onboarding-board.mjs`): scan child (ELECTRON_RUN_AS_NODE) streams progress → `case-file` workspace → staggered seeding via the same authoritative ops the agent tools use → `board.json` (role→surface id, the brain's map). **Adaptive slots**: fixed cards own slots; flex (hero B, E, F, I) assigned by scan shape — web-first puts Workflows in the hero, FDA-off reserves I for the unlock card. Grid fits the renderer's primary-rect clamp (1320×780; clamp regression test-guarded).
- **Boot opener** (`OnboardingFlow.tsx` + `onboarding.css`): aurora wash, breathing wordmark, bar eased toward real scan stages + live signal counter, dissolve-to-canvas at seeding. `ONBOARDING_MODE='always'` while iterating.
- **FDA unlock card** (`UnlockWidget.tsx`, native, runtime-only in both isRuntime predicates): Settings deeplink, main polls the TCC probe, on grant Branch-A rescan deepens the board in place, card celebrates + retires. Granted path verified live; locked→grant path unit-tested only (this dev machine already grants Electron FDA).
- **Theming**: UI kit gained the paper palette tokens (`--blitz-coral/terracotta/sage/slate/dust/mauve/tan/marker`, design-system §3) and a **universal `props.accent`/`accentInk` hook** (any widget recolors itself — documented in WIDGET_AUTHORING_MD). Planner assigns per-role accents (a distribution, not one color).

## TODO (next; user-flagged 2026-06-10 + carried spikes)

- [ ] **Tweak the color theme** — current per-role palette assignment is a first pass; revisit accent choices/contrast, and extend theming to the native unlock card + OS chrome (the full Spatial redesign in `agent-os-design-system.md`).
- [x] **Non-overlappable fixed widgets (macOS-desktop-style)** — DONE 2026-06-11: the stage slot desktop shipped (`plans/blitzos-stage-slot-desktop.md`, user-built), and the board planner now places ON the lattice (see work log below). The hand-tuned slot coords + renderer clamp dance are gone.
- [ ] **Test both A/B branches live** — exercise the FDA-locked boot (Branch B board + unlock card + grant→deepen) on a machine/state where Electron lacks FDA (revoke via System Settings; dev-TCC attribution spike folds in here).
- [ ] **CRUD the default board widgets (offline tier)** — let the human add/remove/edit the default cards without any brain: editable card fields fire `blitz.action` corrections, removed cards stay removed across reseeds, an "add card" affordance offers the template set, and the deterministic fill keeps working fully offline.
- [ ] Carried: scan runtime budget on slower disks; favicon fetches are external requests (offline fallback exists — decide if web-workflow icons should be opt-in); packaged-build script resolution (`app.getAppPath()/scripts` + `src/main/*.md` templates); workspace note in CLAUDE.md "No layout persistence yet" is stale (predates folder-backed workspaces).

## Work log — P2 (2026-06-10, same session)

**The primary agent's first duty shipped.** The interview rides the EXISTING per-agent machinery (`launchAgent` → `terminal-manager.mjs` → a supervised, VISIBLE `claude` tmux terminal with fresh primary sessions, auto-restarted on exit) — no separate runtime was built:

- **Standing-duty seam** (`agent-runtime.mjs` `setBootTaskProvider`/`getBootTask`, policy-free): the launcher re-reads an optional duty string per (re)launch and injects it into the bootstrap prompt with an explicit license to act unprompted for its scope. Agent '0' threads `interviewBootTask()` (index.ts: `setBootTaskProvider((id) => id === '0' ? interviewBootTask() : null)`) — returns the interview duty while `interview.json` is `pending`, then returns the resident initiative duty after it is `done`.
- **The duty doc** `src/main/blitzos-interview.md` → copied to `<ws>/.blitzos/onboarding/interview.md`: read `context.md` (now `--prompt`-combined interviewer rules + scan) + `scan.json` + `board.json`; ask via ```blitz-ui choice cards in chat (≤4 MC + 1 open voice); update board cards + flip gaps `done` per answer; finish = "What I learned" + write `profile.md` + mark `interview.json` done; then stay resident, folding edits/annotations into board+profile. Hard rails: props-only updates on board ids, no rearranging, no nagging.
- **Launch branch** (`startInterviewPhase` in the director): `claude` CLI resolved via LOGIN shell (`claudeCliPath()` — GUI PATH misses homebrew; the resolved path also feeds `brainCmd`) → kick brain '0' (`osKickBrain`, new osActions export). No CLI → explicit chat error. There is intentionally no canned/static fallback; the real Claude interviewer owns the first question and every follow-up.
- **Verified live**: brain 0 spawned at board-ready with the duty (`cmd=/opt/homebrew/bin/claude`), interview artifacts in place, `interview.json` pending.
- **NOT shipped — the gateway tier**: no hosted endpoint exists yet, so the disclosure card + gateway client + in-main loop remain open. The decided shape stands (full scan through the gateway, plainly disclosed, smartest model); next concrete steps: stand up the worker (blitz.dev infra), then an in-main loop bound to the same duty doc. Also open: brains still ride the RELAY url — a localhost-transport brain (control server would need to serve `agents.md` + a token-in-prompt) would cut the relay dependency for onboarding.
## Work log — the board moves onto the stage lattice (2026-06-11)

The stage slot desktop (`plans/blitzos-stage-slot-desktop.md`, built by the user in a parallel session) replaced free pixel placement with a 180pt slot lattice; the onboarding board now rides it natively:

- **Planner** (`onboarding-board.mjs`): pixel SLOTS deleted. Each card declares a CONTENT-driven span (`SIZE_FOR`: profile l, projects xl hero, rhythm l for the 24-col punchcard, workflows tall at ≥6 rows else l, people/voice/schedule/gaps m-or-l by item count, sessions m) and `findSlot` places it against the LIVE surfaces (the pinned chat hub's tall span included), with composition steered by `near` hints, not coordinates. No span fits → shrink one size at a time (floor m) → park off-stage below the stage frame (alive, `bring_to_stage`-able). The unlock card joined the plan (role `unlock`, native) so it gets placement priority right after gaps; `findUnlockSlot` covers the cached re-ensure path. The board deliberately saturates the stage past the agents' soft STAGE_BUDGET (it IS the first desktop); the lattice is the hard cap and the brain curates down from there.
- **Director** (`onboarding.ts`): seeds with `buildBoardPlan(scan, liveStage())` (live surfaces + viewport), passes `slot`/`slotStage` on staged cards and parked x/y/w/h on overflow.
- **Instruction surfaces swept**: `blitzos-interview.md` gained "Curate the stage" (size follows content via `place_widget {id,size}`, promote parked cards with `bring_to_stage`, retire with `send_backstage` never close, curate DOWN toward the 16-unit budget, one-line `say` per move) and its hard rail now licenses slot-tool placement instead of forbidding all rearranging. `blitzos-onboarding.md`'s stale "real onboarding UI will be designed later" line now points in-OS runs at the duty doc + board. `blitzos-agents.md` and WIDGET_AUTHORING_MD were already stage-fluent (user's pass).
- **Test** (`test-onboarding-seed.mjs`, 54 assertions): per-cell overlap detection incl. the chat hub, lattice-bounds, content→size rules, shrink-then-park under a tiny viewport, unlock-in-plan, web-first prime-span priority, em-dash sweep on all props.
- Decided NOT yet: the gateway tier stays parked until everything works with local claude (user call, 2026-06-11).

- **Strict prose style (user-mandated, 2026-06-10):** absolutely NO em dashes in anything the human reads, and Apple's Siri response guidelines are the style reference (archived verbatim at `plans/siri-prompt.md`; already present and byte-identical to the gist). Distilled rules live in the manual (`blitzos-agents.md`, "Talking with the user"): substance first in one breath, depth after in a few beats, no dash/colon title separators, plain bullets, bold sparingly, shape follows data, grounded or absent, plain honesty, steady voice. Mirrored into `blitzos-onboarding.md` (Style section), `blitzos-interview.md` (rewritten clean), and WIDGET_AUTHORING_MD (widget copy rule). All shipped human-facing copy swept (board cards, unlock card, boot stages, widget samples, the scan's gap questions); both test suites now assert no em dash ever renders.
