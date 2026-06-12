# Guardian Angel BlitzOS — make any connecting agent the principal's GA

> **⚠️ Stale runtime references (2026-06-11):** the headless `agent-runner.mjs` "brain" (`startAgentRunner`, a respawning `claude -p`) this doc builds on was **DELETED**. An agent is now a **visible `claude` running in a tmux terminal**, supervised + auto-restarted by `terminal-manager.mjs`; the agent command, bootstrap prompt, and policy-free boot-task/duty seam live in `agent-runtime.mjs` (`setBootTaskProvider`). Map every `agent-runner.mjs` / `claude -p brain` reference below onto that. The thesis (swappable brain, zero per-task code) is unchanged.

**Status:** Proposal / design (2026-06-06). No core code changed yet.
**Source idea:** Gwern Branwen, *"Guardian Angels: LLM Personalization for Productivity and Security"* — full text installed at `plans/guardian-angel-gwern.md` (retrieved 2026-06-06).
**Companion docs:** `agent-os-dynamic-architecture.md` (the substrate, L1–L5 layers, §0 locked decisions, P0–P6 roadmap), `agent-os-desktop-architecture.md` (Electron plan), `CLAUDE.md` (BlitzOS guidance). GA is the **policy + identity + memory** layer that the pure-substrate architecture deliberately left to "the agent" and to the "OPEN memory model."

---

## 0. Thesis (read this first)

Gwern prescribes a "local, CLI-first, logging-oriented UI/UX paradigm" in which the human is the **CEO of an AI corporation** — they define *what is worth doing*, not *what or how* — and an **append-only log** is the core data structure. **BlitzOS already built that substrate.** It just built it as a *generic OS for any agent*, not as *one principal's guardian angel*.

So GA is **not a new direction** for BlitzOS — it is the coherent filling-in of slots the architecture left open on purpose:

- §0 decision #6 ("BlitzOS is PURE SUBSTRATE; the connected agent makes ALL decisions") means **all GA behavior lives in the agent's prompt + the journal, not in BlitzOS code.** GA is policy. It rides the existing substrate.
- §0 decision #4 ("Memory model = OPEN... the *learned-preferences* tier is deliberately undecided") is **exactly the question GA answers**: the learned-preferences tier is *the principal model* — their values, voice, and preferences, learned from corrections.
- §7 open questions (proactivity-dial default, how much content leaves the device, single vs multi-account) get a principled answer from the **single-situated-principal** commitment (§4 below).

**One-line goal:** any agent that connects to BlitzOS — relay Claude today, a `claude -p` runner, a local model later — boots as **one principal's guardian angel**: *amplify, never replace; be sovereign to the principal alone; help them become themselves.*

---

## 1. What a Guardian Angel is (Gwern, distilled)

(Full argument in `plans/guardian-angel-gwern.md`. The load-bearing parts for BlitzOS:)

- **Emulate the principal to amplify them.** Not the generic "helpful assistant" persona — a model of *this* user's personality, values, preferences, that plans and evaluates as they would, and writes in their voice. The principal does the meta-work (defining what's worth doing, answering hard questions); the GA does the object-level work.
- **Three non-negotiable principles:**
  1. **Enhancement, not Replacement** — amplify the principal; never be the camel's nose for some third party replacing them.
  2. **Mental Sovereignty** — aligned with the principal alone; *no optimization pressure they didn't ask for* (no ads, no engagement-farming, no "ToS/social-harmony" nudging inside the GA).
  3. **Self-Actualization** — help them become *more themselves*, not regress to a bland average.
- **Security via situated identity.** Because the GA is hardwired to one unique, situated principal, prompt-injection and "confused deputy" attacks are *absurd to it* ("why would *this* principal email their passwords to a stranger?"). It treats tokens in its context as **data to look at, not a program to run** — like you reading a phishing email instead of obeying it. A first-class job is **screening** the principal's incoming flood (scams, spearphishing, synthetic-media/slop).
- **The chatbot failures GA fixes:** mode-collapse (frozen generic persona), laziness (System-1, minimum-effort), brittleness (frozen weights → fatal errors), too-helpful (re-programmable → attackable), amnesiac (your corrections are thrown away each session).
- **UX = the append-only log.** Everything is a log item (statements, Q&A, commands+results, ingested/augmented docs), in temporal order; the model can be retrained/upgraded at any time.
- **Active learning / elicitation.** When uncertain, *ask* — but ask well: brainstorm many questions, draft hypothetical answers, ask only the single highest-information one (the "interview prompt"). DAgger-style: each correction gives low-regret convergence. The principal's time goes to *meaningful* choices, avoiding "automation fatigue."
- **Daydreaming.** In downtime, recombine random log items (anti-spaced-repetition for serendipity) to mine novel connections and reminders. "If it's sitting idle, something has gone wrong."
- **Data augmentation.** Don't train on raw logs — annotate them ("what this statement *means*"), maintain a global `PRINCIPAL.md`, measure a question's value by how much it changes `PRINCIPAL.md` (a compression proxy).
- **Hardware/trust.** Local models (4th-Amendment privacy) or end-to-end crypto; cloud SaaS is inadequate (third-party doctrine). Throughput: a GA should be saturated; idle is a bug.

---

## 2. Why BlitzOS is already a GA substrate

| Gwern's GA primitive | BlitzOS seam that already exists |
|---|---|
| Append-only log = core data structure | the journal — `src/main/journal.mjs` (sandboxed md FS: ls/cat/write/append/grep), `journal/mandate.md` + `journal/state.md` read on connect |
| Lifelog / continuous perception | the moment stream — `src/main/perception-core.mjs` (`INJECT` sensors → coalescer → `/events`) |
| Principal as oracle, *queried* | the in-canvas Chat: `say` tool + `trigger:'message'` moments (`emitUserMessage`) |
| "Ask before acting" / veto | Cmd+Z layout revert (store `layoutHistory`) + write-confirm on outward actions (L5, roadmap P3) |
| Situated trust boundary (data ≠ command) | `redactMoment` (`perception-core.mjs`) already separates **principal-authored** chat from **scraped page content** |
| Swappable brain, zero per-task code | "any connecting agent *becomes* BlitzOS" *is* the contract (`src/main/blitzos-agents.md`); the agent-runner boots/auto-restarts a `claude -p` brain (`src/main/agent-runner.mjs`) |
| Local-first trust | Electron MVP, Keychain tokens, the brain on the localhost-trusted path (§0 decision #1) — matches Gwern's "run local for 4th-Amendment privacy" |

The substrate is ~70% of a GA. What's missing is the **personalization + sovereignty + elicitation + screening** layer — almost all of it prompt + journal, not plumbing.

---

## 3. The honest limit, and the reframe (frozen weights → corpus flywheel)

**Be honest (CLAUDE.md: no hacks, no hand-waving):** Gwern's *deepest* mechanism is **in-weight** personalization — dynamic evaluation / online finetuning of the model on the principal. BlitzOS is **pure substrate**; the brain is a **frozen** frontier model (relay Claude or `claude -p`). **BlitzOS cannot finetune it.** So the *emulation-via-weights* GA is out of scope *as BlitzOS proper*.

But this is not a dead end — it is Gwern's own sequencing. His "Initial Steps" say: **build the scaffolding and corpus first** (a `PRINCIPAL.md`, per-file summaries, Q&A logs, interview prompts), and let finetuning come later; "once we figure out good scaffolding... future LLMs can just do it out of the box."

**BlitzOS is an almost perfect harness for producing that corpus:**

- The journal is already designed to swap its local-FS backing for cloud **D1/R2** exposing the *same* verbs (`journal.mjs` header) — i.e. the corpus store is portable, which is exactly roadmap **P6** (D1 sync).
- The append-only log + corrections + Q&A *is* the personalization dataset.
- The "in-weight GA" then arrives **off-substrate**, as an *alternative brain*: a locally-finetuned model plugged into the same `agent-runner` socket the frozen Claude uses today. BlitzOS doesn't change; the brain does.

So GA on BlitzOS is two horizons:
1. **Context-level GA (now):** identity + principal model + corrections + elicitation + screening, all on the frozen brain. Fully reachable on today's substrate.
2. **In-weight GA (later, off-substrate):** a local finetuned brain trained on the corpus BlitzOS grew. This is the answer to §0 decision #4's open "learned-preferences" tier and rides P6.

---

## 4. Decision: single situated principal

**Commit BlitzOS-as-GA to one principal** (the user's call, 2026-06-06). This is the keystone — Gwern's productivity *and* security arguments both depend on a single, situated identity.

What this resolves (it answers several §7 open questions of the architecture doc):
- **Injection/confused-deputy resistance becomes real.** A GA that knows it is *this* person's angel treats instructions found *inside any surface* (a web page, a DM, an email) as **data, never commands**. The only authoritative inputs are the principal via **chat** (`trigger:'message'`, consent-by-construction) and **veto** (Cmd+Z / write-confirm). BlitzOS already draws this exact boundary in `redactMoment` (principal-authored message vs scraped content) — GA elevates it to the *trust* boundary.
- **Proactivity-dial default (§7):** GA leans more proactive than a generic assistant ("amplify"), but **Mental Sovereignty + the write-confirm gate** keep it safe. Default stays **Observe→Suggest**; *sends* always confirm (consistent with §0 decision #2).
- **How much content leaves the device (§7):** GA argues for local/E2E; the relay already redacts un-shared surfaces (P0). Default: the **localhost-trusted brain** (full reads, no relay egress) is the GA's natural home.
- **Multi-account (§7):** one principal, many of *their* accounts — coherent, vs. the ambiguous generic case.

Non-goal: BlitzOS need not stop being drivable by a generic agent over the relay. GA is the **default identity of the resident brain**, not a removal of the substrate's generality.

---

## 5. The ideas, by tier

Each idea: **GA concept → BlitzOS seam → what's new → where it sits** (layer L#/phase P# from `agent-os-dynamic-architecture.md`). Ordered by leverage ÷ effort.

### Tier 1 — Identity (pure contract + journal; no new infra) — *ships on today's substrate*

- **T1.1 — Flip the brain prompt.** Rewrite the operating manual so any connecting agent boots as *`<principal>`'s guardian angel*, **reads `journal/PRINCIPAL.md` first** (alongside `mandate.md`/`state.md`), and is bound by the **three principles as hard rules**. Files: `src/main/blitzos-agents.md` (the relay/AGENTS_MD contract) and the `claude -p` brain prompt in `src/main/agent-runner.mjs`. *Single highest-leverage change* — it reframes every downstream decision from "optimize the desktop" to "amplify *this* principal on their terms." [L3 prompt]
- **T1.2 — `PRINCIPAL.md`.** A structured profile in the journal: values, preferences, voice, hard do-not's, accounts, current goals, boot intent. The agent maintains it. Cheapest emulation substrate *and* the seed of the future corpus (§3). Aligns with the `Profile` schema already sketched in dynamic-arch §5 — GA adds the **learned** fields that §0 #4 left open. [L4 journal/profile]
- **T1.3 — Voice capture.** Record the principal's writing voice so agent-authored surfaces (notes, drafts, replies) sound like *them*, not chatbot-slop — Gwern's central complaint. Extends the **design-language** discipline already in the contract (`blitzos-agents.md` §"Design language") from *visual* anti-slop to *verbal* anti-slop. [L3 prompt + L4]
- **Principle → guardrail mapping (the hard rules):** *Sovereignty* ⇒ "no optimization pressure the principal didn't ask for" (rules out engagement/ad/retention behavior); *Enhancement* ⇒ "never quietly do the whole job in a way that writes the principal out of the loop — surface the work, keep them the author"; *Self-Actualization* ⇒ "prefer options that develop the principal's own ideas over averaging them away."

### Tier 2 — The preference flywheel (small seam additions) — *rides P4 persistence*

- **T2.1 — Capture veto as a DAgger correction signal.** Every veto is the principal acting as oracle with the *right answer* — and BlitzOS currently throws all of them away. Log them with context as `correction` entries:
  - **Cmd+Z layout reverts** (store `layoutHistory`) → "the GA's arrangement was wrong; here's what they undid."
  - **write-confirm rejections** (the L5/P3 gate) → "they would not send/approve that."
  - **content-share toggles** (👁, `setContentShare` in `perception-core.mjs`) → "what they consider private."
  - **chat corrections** (`trigger:'message'`) → explicit feedback.
  This is the richest, cheapest personalization signal in the system and **it already flows** — it just needs to be emitted + logged. DAgger's no-regret bound is precisely Gwern's CIRL argument for why this converges fast. [L4 + L5 emit]
- **T2.2 — Append-only interaction log.** Formalize `journal/log/` (time-ordered: principal statements, Q&A, corrections, accepted/rejected actions, ingested docs) — Gwern's core data structure *and* the training corpus. The journal already supports `append`; this is a convention + a small writer, not new infra. Maps to `BrainState.seen` + the learned-prefs tier in dynamic-arch §5. [L4]
- **T2.3 — Data augmentation.** Periodically annotate raw log items ("what this meant"), fold deltas into `PRINCIPAL.md`. Use Gwern's value-of-question metric: a question/insight is worth more the more it changes `PRINCIPAL.md` (compression proxy). Runs in downtime (ties to Tier 4). [L3 policy + L4]

### Tier 3 — Active learning + the guardian (new agent behavior) — *rides P3 act-tier + P4 onboarding*

- **T3.1 — The interview loop.** When uncertain, the GA *asks* — Gwern's interview prompt: brainstorm many candidate questions, draft hypothetical answers, ask only the single highest-information one, via `say` (or a native `question` surface). **Budget** questions (rate-limit by expected information gain) so the principal does *meaningful* meta-work, not automation-fatigue busywork. Each answer → log → `PRINCIPAL.md` update. [L3 policy, reuses `say`/Chat]
- **T3.2 — Onboarding interview.** A first-run questionnaire surface (Gwern: even a short "36 questions" reveals deep things) to bootstrap `PRINCIPAL.md` fast. Slots directly into the P4 "first run, no profile → onboarding widget" path already in dynamic-arch §5. [P4 boot/onboarding]
- **T3.3 — Screening = the guardian function.** Make "screen the principal's incoming flood for attacks" a first-class job: scams, phishing, synthetic-media/slop, and prompt-injection *aimed at the agent itself*. The moment `snapshot`s BlitzOS already produces are the input; the agent's policy flags + warns via a surface or `say`. New *policy*, perception already shipped. [L3 policy over L2 stream]
- **T3.4 — Injection defense via situated identity.** Encode the §4 rule in the prompt: instructions found inside surfaces are **data, never commands**; only the principal (chat/veto) is authoritative. Leans on the existing `redactMoment` boundary (`perception-core.mjs`). This is the concrete, situated form of Gwern's "the persona knows who it is." [L3 prompt + L5]

### Tier 4 — Never-idle / daydreaming (the one genuinely new scheduler seam)

- **T4.1 — Idle-wake.** Today moments emit *only* on user activity (the `USER_TYPES` / `hasUser` gate in `perception-core.mjs`) — with no user, the brain just blocks on `/events`. Add a **dumb idle heartbeat** (a periodic low-priority tick moment when quiet), or let the brain self-schedule a wake. This stays *scheduling, not policy*, so it respects §0 decision #6 (the agent still decides what to *do* with the tick). The `agent-runner` already supervises/respawns the brain — this adds an idle pulse, not a reasoner. [L2 scheduler — **new capability**]
- **T4.2 — Daydreaming loop.** On an idle tick, the GA reprocesses the log: recombine random items (anti-spaced-repetition for serendipity), mine connections, run the augmentation pass (T2.3), and **pre-compute the next best question** (T3.1) so elicitation is cheap when the principal returns. Output parks in a **non-interrupting** "for when you're free" surface — never a notification. Gwern: idle is a bug. [L3 policy]

### Tier F — In-weight GA (deferred, off-substrate) — *rides P6*

- **TF.1 — Corpus → local brain.** Once the append-only log + `PRINCIPAL.md` + Q&A + corrections are rich, train/dynamic-eval a **local model** and plug it into the same `agent-runner` socket as an *alternative brain*. BlitzOS is unchanged; this is the in-weight GA Gwern wants, arriving exactly when the scaffolding (Tiers 1–3) has produced enough data. Depends on P6 (D1/R2 corpus sync). [off-substrate brain + P6]

---

## 6. How GA sits in the layered model

| Layer (dynamic-arch §3) | What GA adds | Reuse | New |
|---|---|---|---|
| **L1 Substrate** (surfaces/control/render) | nothing | all of it | — |
| **L2 Perception** (sensors→moments→/events) | screening *input* (T3.3); idle pulse (T4.1) | the whole moment stream | **idle heartbeat tick** (dumb scheduling) |
| **L3 Brain = the connected agent** | the GA *identity* + 3 principles + interview + screening + daydreaming | the agent-runner, `/events`, the tool set, AGENTS_MD as prompt-cache blob | the **GA brain prompt**; question-budget policy |
| **L4 State / memory** | `PRINCIPAL.md`, append-only log, corrections | journal FS; the `Profile`/`BrainState` schema; the userData/atomic-write seams | the **learned-prefs tier** (answers §0 #4); `correction` log writer |
| **L5 HCI / consent** | corrections *are emitted here* (veto = signal) | the write-confirm gate, Cmd+Z, content-share consent | emit veto events into the log |

**Reading:** GA is overwhelmingly **L3 prompt + L4 memory**, with one small **L2** scheduling addition (idle-wake) and L5 reused as a *signal source*. It does not touch L1 and adds **no decision logic to BlitzOS** — fully consistent with the pure-substrate directive.

---

## 7. Roadmap fit (GA slices mapped onto P-phases)

- **GA-0 — Identity (Tier 1).** `PRINCIPAL.md` + brain-prompt identity flip + 3 principles + voice. **Ships on the existing substrate, today** (no dependency on unbuilt phases). Highest leverage.
- **GA-1 — Preference flywheel (Tier 2).** Append-only log + correction capture. Rides **P4** persistence; correction *sources* exist now (Cmd+Z, content-share) and grow as the **P3** write-confirm gate lands.
- **GA-2 — Elicitation (Tier 3.1–3.2).** Interview loop + onboarding. Rides **P4** boot/onboarding.
- **GA-3 — Guardian (Tier 3.3–3.4).** Screening + injection hardening. Rides **P3** act-tier + L5; the perception input is ready now.
- **GA-4 — Daydreaming (Tier 4).** Idle-wake + reprocessing. New **L2** scheduler seam; otherwise agent policy.
- **GA-5 — In-weight GA (Tier F).** Corpus → local brain. Deferred behind **P6** (D1 sync).

Critical-path note: GA-0 is independent and can start immediately; GA-1..GA-3 interleave with the substrate's own P3/P4; GA-4 is the only one needing a (small, dumb) new BlitzOS capability; GA-5 is a research bet, not substrate work.

---

## 8. Open questions for the user (carry forward — do not assume)

1. **Voice corpus.** Does the principal have a Gwern-style existing corpus (writing, chat logs) to seed `PRINCIPAL.md`/voice, or do we bootstrap from zero via the onboarding interview (T3.2)?
2. **Proactivity default under GA.** Keep Observe→Suggest (with sends always-confirm), or let the principal dial GA more autonomous per-verb/per-account sooner? (GA's "amplify" pulls proactive; Sovereignty + write-confirm are the brakes.)
3. **Content egress.** Should the GA default to the **localhost-trusted brain only** (no relay content egress), making "local/E2E privacy" the default per Gwern's hardware section?
4. **Where the GA brain runs.** Relay Claude (zero-install) vs a local `claude -p` runner (localhost path, full structured reads — the GA's natural home, and the seat a future local model would take). Affects T2/T3 (structured reads) and TF.
5. **Screening scope (T3.3).** Which inflows first — the web surfaces the principal opens, or connected-integration content (Gmail/Discord)? And how loud may a warning be (passive flag vs interrupt)?

---

## 9. Sources

- `plans/guardian-angel-gwern.md` — the full article (the ideas above are distilled from it).
- `agent-os-dynamic-architecture.md` — substrate, §0 locked decisions (esp. #4 OPEN memory, #6 pure substrate), L1–L5 layers, P0–P6 roadmap, primitive-reuse table.
- Key seams verified in code: `src/main/perception-core.mjs` (moments, `USER_TYPES`/`hasUser` gate, `redactMoment`, `setContentShare`), `src/main/journal.mjs` (the append-only FS, local→D1/R2 portability), `src/main/blitzos-agents.md` (the agent contract), `src/main/agent-runner.mjs` (boots/respawns the brain), `src/renderer/src/store.ts` (`layoutHistory`, `focusAndZoom`).
