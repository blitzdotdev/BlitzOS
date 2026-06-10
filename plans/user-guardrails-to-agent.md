# TODO — Deliver the user's onboarding guardrails to the agent (the "outward-write rail", reframed)

**Status:** TODO — filed 2026-06-10 by Minjune. Designed + grounded against the live tree this session; not built.
**Supersedes:** the earlier "surface_control write classification + instruction-as-consent gate" framing (rejected — see §1).
**Companion:** `session-tape-and-daydreaming.md` (B.3 proposed an OS-enforced surface_control away-gate — superseded by this for the same reason), the Mirror memory ("only write-confirm + STOP stay as OS-enforced rails; significance/act-vs-notify is the AGENT's policy").

---

## 1. The decision: NO new OS guardrail. Deliver the user's rules instead.

The investigated gap was that `surface_control` (CDP click/type/key into a logged-in web surface) is **ungated**, while `provider_call` writes pop an approval card — an asymmetry I demonstrated by sending a real email via `surface_control` with zero OS confirmation.

The proposed fix (an OS-enforced write-classification / instruction-window / presence gate) is **rejected**:
> "there should be minimum guardrails, the model already has guardrails we don't need to add extra. the user also provides guardrails during onboarding — with more general rules like 'seek approval before sending messages to a real human'." — Minjune, 2026-06-10

So the OS stays minimal. Guardrails come from **(a) the model's own training** and **(b) the user's standing rules set at onboarding**. The agent owns the policy of *when* to seek approval; the OS only provides the *mechanism*.

**OS-enforced rails — unchanged, the only two:**
- `provider_call` write-confirm (the request-bound approval ledger + card) — kept.
- STOP (the per-session Stop button kills the brain; `osStopChatSession`) — kept.

**Do NOT add** any gate to `osControlSurface`. `eval` stays localhost-only (already).

## 2. The actual gap

The mechanism for the agent to seek approval **already exists**: `request_action` (`os-tools.mjs` `/request_action`, kind `'approve'`) surfaces a checkable card in the Action-items inbox and wakes the agent via `/events` `trigger:'action'` when the human ticks it. So when the agent's policy says "ask first," it can.

What's **missing**: the user's onboarding guardrails never reach the agent.
- Onboarding already asks the right questions (`src/renderer/src/onboarding/questions.ts`): *"Always ask first / Ask before anything is sent / Trust me on routine stuff"*, *"Anything Blitz should never touch?"*, *"Proactive / Suggestive / Quiet"*.
- But those answers are not persisted anywhere the agent reads, and the served doctrine (`src/main/blitzos-agents.md`) has **no slot** for user rules — it only injects `{{CONNECTORS}}`.

So "seek approval before sending messages to a real human" is a rule the user *can express* but that *never binds the agent*. Closing that is the whole task.

## 3. The minimal build (a file + an injection + a doctrine line)

1. **House-rules store** — a machine-global file `~/Blitz/.blitzos/rules.md` (guardrails are cross-workspace, so root-level, alongside the item-1 runtime journal at `<root>/.blitzos/state.json`). Human-editable. Helpers in `workspace.mjs`: `readUserRules(root)` / `writeUserRules(root, md)` (atomic, size-capped). Seed a default on first boot containing the example rule so it's never empty:
   > - Seek approval before sending a message to a real human (use `request_action`, wait for the tick).
   > - Never act on anything I marked off-limits during setup.

2. **Inject into the served doctrine** — add a `{{RULES}}` placeholder to `blitzos-agents.md` (a new short "House rules" section), and fill it everywhere `{{CONNECTORS}}` is filled:
   - `src/main/agentSocket.ts` (`injectConnectors(AGENTS_MD)` at serve time) — relay.
   - `preview/backend.mjs` (`injectConnectors(OS_AGENTS_MD)`) — server.
   - (`integrations.ts` `injectConnectors` is the shared filler — extend it, or add a sibling `injectRules`, so both transports stay identical.)
   Result: every agent that connects reads the user's standing guardrails as part of its instructions.

3. **The doctrine line** (in `blitzos-agents.md`, the new section):
   > ## House rules (the user's standing guardrails)
   > {{RULES}}
   > These are the user's own rules; honor them above your defaults. When a rule says to seek approval before an action — e.g. before sending a message to a real human — use `request_action {kind:'approve'}` and wait for the human to tick it before doing the thing. STOP always halts you immediately.

4. **Seed from onboarding** — wire the onboarding answers (approval posture, never-touch list, autonomy level) to compose + `writeUserRules`. The onboarding flow (`OnboardingFlow.tsx`) is mid-refactor (Min's WIP), so this step coordinates with that work; the rules file + injection (1–3) are independent and can land first.

## 4. Why this is right

- **Minimal + pure-substrate**: no OS classifier, no presence infra, no per-click gate. The OS gains one machine-global file + one doctrine injection. Policy stays the agent's.
- **Reuses what exists**: `request_action` (seek approval) + the provider write-card + STOP. Nothing new to enforce.
- **Binds the rule the user actually wants**: "ask before messaging a human" goes from an un-delivered onboarding answer to a line in every agent's operating instructions.

## 5. Open decision

- Rules **machine-global** (recommended — guardrails like "ask before sending" are not workspace-specific) vs per-workspace. Lean: global.

## 6. Seams (verified this session)

- Approval mechanism: `src/main/os-tools.mjs` `/request_action` (kind `approve`) + the Action-items inbox.
- Doctrine + injection: `src/main/blitzos-agents.md` (`{{CONNECTORS}}` only today); `injectConnectors` in `src/main/agentSocket.ts` + `preview/backend.mjs` (+ the shared filler in `integrations.ts`).
- Onboarding capture (answers, not yet persisted to the agent): `src/renderer/src/onboarding/questions.ts` + `OnboardingFlow.tsx`.
- Root-state location for a machine-global file: `<root>/.blitzos/` (the item-1 journal lives here as `state.json`).
- Kept rails: `provider-call.mjs` (write approval ledger), `osStopChatSession` (STOP).
