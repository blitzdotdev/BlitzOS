The decisive facts are confirmed in the real tree: `instrument` (os-tools.mjs:48-72) discards `out` and `ctx.body`, tapping only `{path, transport, ms, status}`; `ingestSignals` (perception-core.mjs:119) collapses raw `r` into the pending moment with no pre-coalesce tap; the Claude JSONL path is computed (agent-runtime.mjs:150) but only `existsSync`-checked; the agent is a `claude`/`codex` TUI spawned `--dangerously-skip-permissions` with no structured model-I/O capture (lines 121, 131); and `meta.json` holds `claudeSessionId` (line 172). The Codex path (line 129) confirms the SKEPTIC/COMPLETENESS X1 gap: the `claudeSessionId`-keyed model-plane collector does not generalize to Codex/hosted backends. I have what I need.

Here is the final recommendation.

---

# BlitzOS Session Tape — Final Recommendation

**To:** Founder
**From:** Lead architect
**Re:** The session tape, designed as the input substrate for the fleet auto-research loop
**Decision posture:** decisive, single design, positions taken. Where I override one of the three drafts or a critique, I say so.

---

## 1. Thesis

The tape is not a log and not a transcript. **It is the input substrate for a fleet re-simulation loop that searches BlitzOS's harness-as-data (prompts, tool specs, perception constants) against objectives that will change, with the model weights held fixed.** Because the loop re-samples a frozen model on recorded *situations* and re-scores stored *trajectories* under a *mutable* objective, the tape must be a boring, objective-agnostic, content-addressed ledger of facts: every agent action stamped with a stable `decisionId` bound to the perception moments that caused it, every byte tagged as world-input or agent-output, the rich bytes kept losslessly on-device and only a small structured redacted subset shipped to the fleet. The tape pre-bakes no score and holds no objective; objectives live off-device as versioned judges over it, so a 2027 constraint is a new file re-run over 2026 tapes. The one hard truth that shapes everything: **BlitzOS owns the effects plane and the perception plane but not the model plane** (the agent is a `claude`/`codex` TUI it shells out to), so literal replay is impossible and the design is built to not need it.

---

## 2. The auto-research loop, concretely

The loop is **AlphaEvolve/FunSearch shape (propose, evaluate, select, archive)** with two twists that dominate the design: the "program" is the agent harness, not an algorithm, and the fitness is learned from human reactions and is mutable. The evaluator, not the generator, is the bottleneck, so the entire design optimizes for cheap, partial, cached, re-scorable evaluation.

```
              ┌─────────────────────────────────────────────────────────┐
              │  ARCHIVE  (MAP-Elites grid + Pareto front)               │
              │  axes: autonomy level · intervention rate · surface-churn│
              └───────────────┬─────────────────────────────────────────┘
                              │ parent + diff + logs (GEPA/DGM: read traces)
                              ▼
   ┌──────────┐   variant   ┌───────────────┐   trajectory_artifact   ┌──────────────┐
   │GENERATOR │────────────▶│   RE-SIM      │────────────────────────▶│  ARTIFACT    │
   │ proposes │  (knobs)    │ Lane A/B/C    │  (new actions+traces+    │  STORE       │
   │ a knob   │             │ on the tapes  │   diffs vs baseline)     │ (durable,    │
   │ variant  │             └───────────────┘                          │  subjectId-  │
   └──────────┘                                                        │  partitioned)│
        ▲                                                              └──────┬───────┘
        │ select (statistical, QD)        ┌──────────────────────┐           │
        └─────────────────────────────────│  SCORE (pure pass)   │◀──────────┘
                                          │ objective × artifact │
                                          │  → score             │   ← objectives are
                                          └──────────────────────┘     VERSIONED DATA, off-device
```

**The single most important structural decision (from eval-corpus-first, IR-4): separate `(variant, tape) → trajectory_artifact` from `objective × artifact → score`.** Re-sim is expensive; scoring is cheap. Store the re-sim trajectory artifact as a durable, subjectId-partitioned object; compute scores as a second pure pass. When the objective changes, re-score every stored artifact without re-running a single re-sim. This is the compounding moat: every re-sim ever run stays reusable under every future objective.

**The realistic restricted search space (not "the whole codebase").** The SKEPTIC is right and all three designs converge here: free-form edits to `osActions.ts`/`perception-core.mjs`/the WebContentsView host overwhelmingly do not compile, deadlock CDP, or crash the host (the tree documents four host races and a popup-policy SIGSEGV). The loop searches **policy-as-data and the harness around a fixed model, never the kernel**, in four tiers by leverage/cost:

1. **Prompts / duty docs** (`blitzos-agents.md`, the bootstrap, the standing perception nudge, `blitzos-interview.md`). Pure text, highest leverage, lowest risk. Where APE/OPRO/GEPA operate directly.
2. **Tool definitions / registry** (`makeOsTools` descriptions, schemas, which tools exist, their gating).
3. **Perception / policy constants** (the coalescer knobs: `BATCH_MS`, `SELECT_DEBOUNCE_MS`, `USER_TYPES`, `visibleTo`, the redact whitelist). Pure functions of raw signals, so they re-simulate deterministically in Lane A.
4. **Harness scaffold** (resume-vs-fresh, model/effort selection, retry, the boot-task seam).

Out of scope for the autonomous loop: kernel, persistence, compositor, IPC. A wrong diff there bricks the app. Structural code edits leave the loop and become human-reviewed PRs gated by the existing `scripts/test-*.mjs` deterministic suites. I am committing to the SKEPTIC's framing in the doc explicitly: **this is harness/context/policy search, with code as a rare manual structural lever**, because pitching it as "autonomously optimize the codebase" is dishonest about both the validity rate and the eval cost.

---

## 3. Replay strategy

**We do not replay the model. We replay the world and the human, and re-sample the model.** Three independent reasons force this and they are not arguable: (a) the model is a vendor-hosted black box BlitzOS shells out to, so there is no place to insert a VCR cassette at the LLM layer; (b) the model updates under us, so even same-prompt determinism breaks across time; (c) a changed codebase changes the model's context on step 1, so the trajectory diverges immediately. The `boundary` field on every row (`env_in` / `agent_out` / `agent_internal`) is what makes this work: every lane replays the `env_in` stream as a fixture and lets the variant produce fresh `agent_out`.

Three lanes, and an objective declares which lane(s) it is valid in:

- **Lane A — static replay, no model calls.** Feed recorded raw pre-coalesce signals through a new perception/coalescer variant; diff emitted moments and wake decisions against the recorded ones. Fully deterministic, no LLM, no divergence. Covers the entire perception-constant tier. **Build this first.** It validates the whole pipeline before paying for any LLM re-sim and is the lane that can federate cheaply (it is a pure function of parameters).
- **Lane B — single-step counterfactual (the workhorse).** At each recorded wake moment, restore the exact observation the agent saw, re-render the prompt under the variant, ask the pinned model for just the next action, score that action against the recorded `effect`, then re-anchor to the real next state from the tape. Divergence never compounds. **This is the only lane where human verdicts still transfer**, because the world state is real. Cacheable.
- **Lane C — free rollout (finalist-only, opt-in).** Drive forward from a session-start checkpoint, generating a diverging trajectory. Human verdicts become priors, not labels; every nondeterminism source compounds; bounded to sandboxable/first-party surfaces; **never against the user's real logged-in accounts** (that is exactly the irreversible action the OS is built to gate); fork at session start, never mid-conversation (mid-conversation needs Claude Code's private session state we do not own). Never the primary plan.

**The honest ceiling, stated where the founder will see it (sharpening replay-first and correcting COMPLETENESS GAP 3):** even with the agent's session JSONL, the most replay-hungry asset (per-turn model I/O) is the least faithfully replayable, and capturing it *more raw does not fix that* because it is a property of not owning the call seam. Worse, the COMPLETENESS critique is correct that the Claude session JSONL contains the *conversation transcript and the agent's reasoning, not the literal rendered prompt or the decoding params* (system-prompt assembly, tool-schema injection, context truncation, and cache-control insertion all happen inside Claude Code after the JSONL is written). **Therefore the fixed-weights response cache cannot be keyed on the JSONL, and I am removing the claim that it "lights up for free" from any milestone.** The cache is a Phase-2 capability gated on owning the model-call boundary via an `ANTHROPIC_BASE_URL` localhost recorder in the agent's tmux env (an agent-runtime change, costed separately). Until then, the JSONL is genuinely valuable for the trace-reading generator and process-reward, and any near-term cache is keyed on the *reconstructable observation* (the moment plus the tool_results that fed the turn), which is a weaker, approximate cache.

**Distribution shift and verdict transfer — the deepest issue, taken as a design constraint, not a footnote (synthesizing the SKEPTIC and all three drafts).** Re-running new code on an old tape diverges, so a human verdict on the old trajectory may not apply to the new action. We handle this four ways, never by silently faking a human label on a divergent trajectory:

1. **Demote verdicts from "labels on trajectories" to a transferable reward signal.** The verdict's value is not "this exact trajectory was good" but "this human, in this context, valued this kind of outcome." Train a reward model `R(state, outcome, human-profile)` from verdicts and score new trajectories under it (the RLHF move: Christiano et al. 2017, Stiennon et al. 2020). **The moat is a cross-user reward model plus hard rails, not a replay corpus.**
2. **Tag every score with a transfer-confidence class:** `exact-anchor` (Lane B, same real state, verdict transfers iff the new action is judged equivalent), `aligned-phase` (segment both trajectories by `trigger` phase boundaries, port verdicts phase-to-phase, flag the rest), `judge-only` (alignment failed: the old human verdict is explicitly degraded to a prior, scored only by judges and programmatic checks that need no human label), or `degraded`.
3. **Outcome labels are state-shaped and path-independent** (the WebArena/AndroidWorld lesson: score the end-state, not the path), via `effect` and `stateHash`, so a different path reaching the same state still scores.
4. **Off-policy evaluation, honestly:** each `(situation, decision, verdict)` is one logged contextual-bandit round, prefer doubly-robust, and **do not attempt full-trajectory OPE** (importance-sampling variance explodes over the long horizon: the curse of horizon, Liu et al. 2018). This is the structural reason single-step Lane B is load-bearing.

The connection the COMPLETENESS critique surfaced and I am committing to: **the search is most judge-dependent exactly where it is most novel (most divergent), i.e. most valuable, i.e. most dangerous.** Section 9 carries the anti-Goodhart rails this forces.

---

## 4. What the tape captures

One logical log. One row = one span, OTel/LangSmith shape, with three load-bearing additions over any observability standard. Append-only JSONL on-device (the `telemetry.ts` `appendFileSync` precedent: crash-safe, tailable, legible). Heavy bytes are never inline; they are content-addressed blob pointers.

**Common envelope (every row):**

```jsonc
{
  "v": 1,                          // TAPE_SCHEMA_VERSION (one owned constant; see §9 GAP-1 discipline)
  "lamport": 81423,                // per-TAPE monotonic order stamped at append (the ONLY within-tape order)
  "moment_seq": 81002,             // stream-local perception seq (demoted: NOT a global key — fixes GAP-2)
  "dotted_order": "00081401.00081418.00081423", // sortable materialized path → rebuild the tree from a flat log
  "parent_seq": 81418,
  "ts": 1749800000123,             // physical clock (cross-process correlation; skew accepted + stamped)
  "dur_ms": 41,
  "tape_id": "m-3f8a.2026-06-13",  // machine bucket + day partition
  "subject_id": "s_7af3…",         // ROTATABLE pseudonym, separately-deletable keystore (NOT device UUID)
  "agent_session_id": "0",         // BlitzOS managed-agent id
  "backend_kind": "claude",        // claude | codex | hosted  (fixes X1: the join key is backend-specific)
  "agent_log_ref": { "path":"…/<sid>.jsonl", "offset":40213, "kind":"claude" }, // REFERENCE, not copy (GAP-6)
  "workspace": "case-file",
  "episode_id": "ep_0091",         // coarse task boundary (workspace-switch / long idle)
  "type": "tool_call",             // closed enum
  "boundary": "agent_out",         // env_in | agent_out | agent_internal  — THE simulator boundary
  "name": "create_surface",
  "status": "ok",
  "model_version": "claude-opus-4-8[1m]@2026-06",  // "fixed weights" only holds WITH this stamped per campaign
  "code_version": "git:c04cc14",   // harness sha — what re-sim diverges FROM
  "harness_surfaces": ["prompt:bootstrap","tool:create_surface","perc:BATCH_MS"], // incremental re-eval slice
  "share": "private",              // shared | private — FROZEN at capture via isContentShared (never recomputed)
  "redact": "clip"                 // none | clip | scrub-required
}
```

`dotted_order` + `parent_seq` give the span tree from a flat append-only file. `boundary` is the field that turns a transcript into a re-executable world. I am taking the COMPLETENESS GAP-2 correction: **stop overloading the perception `seq` as a global key** (it is one in-process counter, and the server transport runs its own `perception-core` with its own `seq=0`). Keep `ts` physical, add a per-tape `lamport` as the only within-tape order, demote `seq` to `moment_seq` (stream-local, which is all it ever was).

**Type-specific bodies (each justified by a loop requirement):**

**`moment`** (`env_in`) — the agent's eyes. Loop requirement: Lane A/B/C all need the world the agent perceived; the snapshot is the cheap world-model. The source `setMomentTap` already sees the full moment losslessly; the loss is the consumer (telemetry.ts drops `snapshot`). Keep it all on the re-sim path.
```jsonc
{ "type":"moment", "boundary":"env_in",
  "moment_seq":81002, "surface_id":"win_812", "url":"…", "title":"Inbox (3)",
  "trigger":"nav",          // nav|idle|message|canvas|action|system — FREE phase boundary for verdict transfer
  "bulk_at":null,           // one-gesture reorder stamp → keeps N moves = 1 decision
  "signals":{"nav":1,"input":4}, "user":["typed in search","clicked Compose"],
  "snapshot_ref":{"hash":"b3:3a…","blobRef":"blob/b3/3a…","bytes":6144,"truncated":true} }
```

**`signal_raw`** (`env_in`) — the pre-coalesce firehose. Loop requirement: Lane A re-runs a *new coalescer variant* and must feed it the raw signals the old one consumed. Today the raw `r` dies in `ingestSignals` (perception-core.mjs:119). Tap before the coalesce. **This is the only kernel addition and the highest-volume stream; it is E0 local-only by default, capped, and decimated** (GAP-6).
```jsonc
{ "type":"signal_raw", "boundary":"env_in", "surface_id":"win_812",
  "raw":[{"type":"input","t":…,"target":"input#q"},
         {"type":"content","digest_ref":{"hash":"b3:3a…","truncated":true}}] }
```

**`tool_call`** (`agent_out`) — the agent's hands, and **the single biggest delta vs the existing spec.** Loop requirement: Lane B reconstructs the state the model saw and the effect the action had; the score reads the effect. Widen the tap from metadata to full args + result. `instrument` already has `ctx.body` and `out` in scope and discards both.
```jsonc
{ "type":"tool_call", "boundary":"agent_out",
  "decision_id":"01J8X…ULID",   // STABLE, minted at instrument() — the join key for every verdict/label/pair
  "name":"surface_control", "transport":"relay",   // relay|localhost|server
  "args":{ "id":"win_812","action":{"kind":"click","selector":"button[aria-label=Send]"} },  // ctx.body
  "caused_by":{ "cursor_at_call":80990, "candidates":[80991,81002] },  // the CANDIDATE wake set, labeled as correlation
  "turn_id":"t_4417", "intent_ref":{"hash":"b3:…","blobRef":"…"},      // stated reason if present (say/think)
  "replay_class":"world-read" }   // pure-read | world-read | local-effect | external-effect (GAP-4)
```

**`tool_result`** (`env_in` — the world's reply) — captures the effect, state-shaped. Loop requirement: outcome labels must be path-independent (so a different path to the same state still scores) and preference pairs need the observable end-state.
```jsonc
{ "type":"tool_result", "boundary":"env_in", "parent_seq":<tool_call lamport>,
  "decision_id":"01J8X…ULID", "ok":true,
  "effect":{ "kind":"click","matched":"visible","url_after":"…","dom_len_changed":true,"value_back":null },
  "result_ref":{"hash":"b3:…","blobRef":"…","truncated":true,"bytes":2048},
  "minted_ids":["win_813"] }     // capture id-minting non-determinism so a fork can re-issue the SAME ids (GAP-4)
```
Note on `effect`: I side with replay-first/federated over eval-corpus-first's hedge. `diffEffect` is real (control-core.mjs), but the COMPLETENESS critique is correct that `dom_len_changed` is a **length proxy, not a content hash** — so it is named honestly as `dom_len_changed`, and a real content hash, if ever added, is a *new* field (`dom_state_hash`), never a silent re-meaning of this one (GAP-1). Where no `diffEffect` exists, capture the generic `out`.

**`llm`** (`agent_internal` for reasoning, `agent_out` for the emitted action) — the model plane we do not own. Loop requirement: the trace-reading generator (GEPA: >10% better with up to 35x fewer rollouts by reflecting on traces) needs the reasoning; process-reward needs the why. Ingested from the agent's session JSONL by reference, joined on `agent_session_id`+`backend_kind`. **Carries the conversation transcript and reasoning, explicitly NOT the rendered prompt or decoding params** (GAP-3).
```jsonc
{ "type":"llm", "boundary":"agent_internal",
  "backend_kind":"claude", "uuid":"…","parent_uuid":"…","forked_from":null,
  "role":"assistant", "content_kinds":["thinking","text","tool_use"],
  "transcript_ref":{"hash":"b3:…","blobRef":"…"},   // the conversation as written to JSONL (NOT the wire prompt)
  "thinking_ref":{"hash":"b3:…","blobRef":"…"},
  "model_plane":"jsonl" }   // jsonl | proxy | none  — "none" for hosted backends is a RECORDED coverage hole (X1)
```

**`os_event`** (`env_in` human-origin, `agent_out` tool-origin) — crashes (`trigger:'system'`), workspace switches, connector changes, bookmark, `bulk_at` reorders. Low volume, mostly E1-shareable.

**`verdict`** (`env_in`, separate stratum) — the highest-signal label and the moat anchor. Loop requirement: the reward model and DPO/KTO pairs are built from these. **The raw reaction is captured as ordinary `os_event`/`signal_raw` rows with `origin:human`; the `verdict` row is computed in a second pass by a versioned attributor**, so a better attributor re-links old reactions.
```jsonc
{ "type":"verdict", "boundary":"env_in",
  "verdict_id":"vd_5521", "attribution_version":"attr@3",   // re-linkable later
  "decision_id":"01J8X…ULID",          // the action it judges (heuristic: same surface, window W, human-origin)
  "kind":"edit",                        // accept|edit|veto|undo|redo|explicit|dwell
  "polarity":-1, "latency_ms":1840,     // fast undo = high-confidence negative
  "confidence":"strong-implicit",       // explicit|strong-implicit|weak-implicit
  "origin":"human",                     // ONLY human-origin counts — and CDP-injected input is tagged origin:tool (GAP-5)
  "affordance":"edit-text",             // edit-text|move|dismiss|ignore — FACTOR the verdict (GAP-5/skeptic)
  "target_surface_id":"win_812",
  "diff_ref":{"before":"b3:d1…","after":"b3:d2…"},   // gold DPO `chosen` — only for artifacts BlitzOS owns the bytes of
  "state_hash":"b3:state_e1…",          // canonicalized LAYOUT_KEYS + BLAKE3 artifact hash (defined now, GAP-5)
  "evidence_seqs":[81051,81052] }        // so the REASON survives a later trim/redact
```

Two corrections I am committing to from COMPLETENESS GAP-5, because they are the difference between a clean corpus and a poisoned one: (1) **CDP-injected page input must be tagged `origin:tool`** at the `cdp.ts` source (reusing the existing `consumeEcho` echo-window pattern), or every `surface_control` action self-generates a fake human verdict — the single most damaging silent error for a corpus-first design. (2) **`affordance`** factors the verdict by what the human touched (edit-text vs move vs dismiss), so a presentation change does not waste a content label. And `diff_ref` is scoped to artifacts BlitzOS owns the bytes of (native/srcdoc/files, snapshotted from the authoritative-on-write content file); a human edit inside a `web` surface (a Gmail draft) has no agent-authored before-image and downgrades to an un-diffed verdict.

**Granularity verdict, stated plainly:** turn-level model I/O = yes but by-reference and as transcript-not-wire-prompt; snapshots = yes, as blob pointers; moments = yes, full; raw pre-coalesce signals = yes, capped and local-only; verdicts = yes, as a separate re-derivable stratum. The one thing the tape never contains is a score.

---

## 5. The mutable-objective layer

This is the property that justifies the whole architecture, and it is achieved by **what the tape refuses to contain.**

1. **Objectives are versioned data, off-device, behind one `score()` interface.** They live in the org's training repo, never on the device, never in the tape. Each objective is one file implementing the interface in five forms over the *same* stored artifacts: (a) a human-verdict label function (reads `verdict` rows), (b) a preference-pair builder — **KTO-unpaired first** because the BlitzOS verdict stream is overwhelmingly lone vetoes/accepts with no replacement (Ethayarajh et al. 2024), plus DPO pairs where an edit `diff_ref` gives a chosen/rejected (Rafailov et al. 2023), (c) a process-reward/step rubric (reads `intent_ref` + `thinking_ref`), (d) a locked LLM-judge rubric (frozen text + pinned judge model + anchored to `evidence_seqs`), (e) an eval-set selector — a saved query over `strata`/`subject_id`/`trigger` that **re-materializes against current tapes**, not a copied corpus.

2. **Facts vs interpretations are physically separated.** The tape is Stratum 0 (immutable facts). Verdicts are Stratum 1 (the human reaction, attributed by a *versioned* attributor stamped `attribution_version`). Scores are Stratum 2 (off-device, stamped `objective_id@version`). Old human verdicts (immutable facts) and objectives (versioned interpretations) never entangle. Adding "respect quiet hours" in 2027 is a new objective file re-run over 2026 tapes.

3. **Re-scoring needs no re-capture and usually no re-sim** (the IR-4 split). A new objective is a pure second pass over stored trajectory artifacts plus a re-projection over the MAP-Elites/Pareto archive.

**What raw capture this forces (the honest cost, from SKEPTIC GAP-4):** the claim "mutable objective over old tapes" is **true within a captured channel and false across channels.** A new objective that re-weights or re-segments an *already-recorded* raw stream is cheap. A new objective that needs a *channel the tap never had* requires a tap change and **cannot backfill history.** The concrete, predictable failure: the first time the org picks "aligned autonomy," it needs the agent's *justification* channel, and the current `stdio:'ignore'` spawn does not capture it. **Therefore the resident agent must capture the reasoning/justification channel from day one** (via the JSONL collector and, for the wire-prompt, the proxy shim), or the objective the org most wants is unscoreable on every tape collected before it is wired. The capture discipline that makes intra-channel mutability real: **capture raw-and-rich within each channel; downsample only at read, never at write.** Dropping "noise" at write is irreversible, and one objective's noise (mouse paths, dwell, hesitation) is another's signal (intent/frustration inference).

---

## 6. Storage, egress, privacy

**The posture I am committing to (federated-evolvable's prior, because it is the only one whose default matches the product's trust moat): the on-device tape is the asset; the central store is a liability to minimize.** Replay fidelity is a *local* asset; fleet fidelity is *structured*. This resolves the central tension correctly: the product's legibility moat and the research moat *agree* on the structured tier and *conflict* only on the heavy tier, so the heavy tier stays home.

**One logical log, three physical substrates (a layering, not a choice):**

```
~/Blitz/.blitzos/tape/                     # at the ROOT, NOT inside a workspace (replay-first's catch:
  facts/session-<YYYY-MM-DD>.jsonl          #   the non-recursive workspace watcher fires scheduleReconcile()
  blobs/b3/<hash>                           #   on every append → a reconcile storm. Avoided by living at root.)
  verdicts/<YYYY-MM-DD>.jsonl               # Stratum 1, attribution_version-stamped, re-derivable
  artifacts/<subject_id>/…                  # IR-4 trajectory artifacts, SUBJECT-PARTITIONED + crypto-shreddable (GAP-8)
  checkpoints/<episode>.manifest            # Lane-C fork points (opt-in)
  keystore/subject.key                      # per-subject crypto-shred key, SEPARATELY deletable
  egress/{queue,sent,consent.json}          # "what leaves this machine" staging + ledger
```

On-device JSONL is the local truth: crash-safe, tailable, human-inspectable. **Gitignored. Default OFF, exactly like today's telemetry (no config = no capture).** The fleet side is **columnar Iceberg/Delta over Parquet**, partitioned by day + subject-bucket, schema-evolving + time-travel so the long-lived corpus adds columns without rewrites and projects per-objective at read time.

**Blob/row write ordering (COMPLETENESS X2, a five-line discipline that is a data-integrity AND a GDPR bug if omitted):** write the blob first (content-addressed, idempotent), fsync, then append the row referencing it, and write the blob→subject index *with* the row. A crash then leaves at worst a GC-able orphan blob, never a dangling row reference and never an un-shreddable blob.

**Egress modes (default OFF, separate from in-product perception-consent, never blurred):**
- **E0 on-device only** (default for `signal_raw`, all blobs, the entire `llm` plane). Full Lane-A/B/C re-sim runs locally.
- **E1 redacted structured corpus → clean room** (the consenting-user default). Only the at-egress redacted structured subset travels: spans + verdicts minus heavy bytes; page-derived content replaced by the scrubbed derivative or dropped. This is what the objective actually consumes (env + verdicts: small, structured, de-identifiable).
- **E2/E3 encrypted-to-attested-enclave raw** (small opt-in deep-replay cohort only). Content-hash-deduped blobs encrypted to a TEE/KMS.
- **End-state: federated re-sim** — ship the candidate variant to the data, return only DP aggregates.

**Two-stage redaction:** at-write (synchronous, structural) = clip-to-blob + hard secret scrub (extend `provider-specs.mjs redact()`; **never tape a `type:'password'` value or a bearer/API token** — a leaked credential cannot be un-leaked downstream). At-egress (asynchronous, **on-device**, lossy) = NER-grade PII scrub via a schema-bound `redactRecord(rec, transport)` that keeps `{seq, ts, origin, kind, surface_id}`, replaces page-derived bytes, reads the *frozen* `share`. Scrubbing runs on-device because scrubbing server-side is itself an egress of unredacted data.

**The SKEPTIC's piercing finding I am acting on immediately:** the current `telemetry.ts` *already ships moments off-device to a configured URL with `url` + `title` + truncated `user[]` typed text*, and `redactMoment` keeps `url+title` (the behavioral graph: which bank, which clinic, at what times; titles carry names and subject lines). **So the honeypot already partially exists.** Action: **bring `telemetry.ts`'s moment egress under the same `redactRecord` boundary (or gate it OFF) before the fleet program starts.** This is M0-blocking, not a later milestone.

**Consent + compliance:** `share` frozen at capture via `isContentShared` (the live in-memory Set is dropped on surface close, so a record outlives its consent unless stamped at append — confirmed in the tree). Rotatable `subject_id`. **Crypto-shredding** (destroy the per-subject key) reconciles append-only/columnar immutability with GDPR Art. 17. Deletion propagates as a tombstone stream into the clean room + KMS-revocation into the enclave. **Differential privacy** on every aggregate that leaves.

**The deletion-into-derived-artifacts gap I am closing (COMPLETENESS GAP-8, the biggest one):** the IR-4 trajectory artifacts are the moat, are derived from tapes, and are re-scored forever — and crypto-shredding the raw tape does *not* cover them. So **the artifact store is subject-partitioned and crypto-shreddable on the same key** (accepting the loss of cross-subject dedup as a real cost), and **the selection step itself is DP** (report-noisy-max over the objective vector), so a deleted user's influence on the *chosen variant* is actually bounded — "DP on aggregates" alone does not bound it. The user-facing contract is honest: "your raw data is destroyed; your influence on already-selected models is mathematically bounded and removed from all future training; no one in the industry can surgically un-train a model your data helped select, which is why we bound influence rather than promise erasure." A DPIA + EU residency are prerequisites.

**Honest limit, not oversold:** content-agnostic capture means the PII scrubber is best-effort, so the redacted E1 corpus is **de-identified, not anonymized** (mosaic re-identification at fleet scale); govern it as still-personal-data. The genuinely strong guarantee is for raw: **data-never-leaves / clean-room**, not "we scrubbed it."

---

## 7. Reconciliation with spec 01

The existing spec (`plans/research/session-tape-and-daydreaming.md`) is the right instinct (append-only, withRecording-at-each-transport, moment tap, local-only/gitignore) aimed at the wrong customer (dashboards). Keep the skeleton; rewrite the parts below.

**KEEP:** append-only JSONL; the `withRecording`/`instrument` wrapper at each transport; `setMomentTap`; local-only + gitignore + default-OFF as the *on-device* posture; the `redactRecord` name.

**CHANGE:**
- **Stop treating the tape as "the corpus."** It is Stratum 0 (facts). Verdicts are a separate stratum; objectives are off-device entirely. This is the inversion that makes objectives mutable without re-capture.
- **Stop clipping by dropping** (the spec truncates-to-sentinel and caps). Clip by content-addressed hash-pointer, or retroactive re-judge under a new objective is impossible.
- **Stop feeding the tool tap metadata only.** Carry args + result + a stable `decision_id`. The biggest single gap.
- **Stop dropping the moment `snapshot`** on the re-sim path, and **stop letting raw pre-coalesce signals die in `ingestSignals`.**
- **Stop binding the human-reaction → decision link at capture.** Record the raw reaction; compute the link with a versioned attributor.
- **Stop calling it "a deterministic, replayable transcript."** It is a simulator-input substrate; literal model replay is impossible.

**ADD:** the `boundary` field; `decision_id` + `caused_by` (candidate set); the model-plane collector keyed on `agent_session_id`+`backend_kind` (not just `claudeSessionId`); the `replay_class` tool taxonomy; the per-tape `lamport` order; `affordance`-factored verdicts with CDP-origin tagging; subject-partitioned crypto-shreddable artifacts + DP selection; schema-version discipline.

**RESOLVE the open decision A.7.4 as YES:** mint a stable `decision_id` at `instrument`, stamp `caused_by` moment seqs, capture `intent_ref`. This is the one field whose absence is unrecoverable — you cannot re-mint stable ids onto a past log and have verdicts agree.

---

## 8. Milestones — build order that de-risks the LOOP first

The loop, not the capture, is the risk. The order proves the cheapest provable thing (Lane A, no LLM, no egress) before paying for anything, then proves the mutable-objective claim, and touches the fleet last.

- **M0 — `session-tape.mjs` + widen the tool tap + mint `decision_id` + close the telemetry honeypot.** New module (config-gated, `appendFileSync`, blob store with write-blob-then-row ordering, ULID minting at `~/Blitz/.blitzos/tape`), the one-line widen of `toolTap` to carry `ctx.body`+`out` (all three transports for free), and **bring `telemetry.ts`'s moment egress under `redactRecord` or gate it OFF.** Smallest slice, highest value, and it closes the existing leak. Default-OFF, E0 only.
- **M1 — Lane A end-to-end (no LLM, the pipeline proof).** Full-moment sink (keep `snapshot`) + the pre-coalesce `signal_raw` tap (the one kernel change) + the `boundary` field + clip-to-blob. Build the static replay harness: re-feed raw signals through a coalescer variant, diff vs recorded moments, store the result as the first `trajectory_artifact`. **This validates the entire re-sim + IR-4 artifact pipeline with zero model spend and zero privacy surface.** Highest de-risk-per-dollar.
- **M2 — Causality + verdicts + the reward signal.** `origin` everywhere (with CDP-injection tagged `origin:tool`), `affordance`-factored edit-diff capture, the versioned attributor emitting `verdict` rows with `state_hash`. Now the tape is `(situation, action, outcome, human-verdict)`. Unlocks DPO/KTO pair building and reward-model bootstrapping offline.
- **M3 — Model plane + the IR-4 score split + the FIRST mutable objective.** The session-JSONL collector keyed on `agent_session_id`+`backend_kind` (record `model_plane:none` for hosted backends as a coverage hole). Build the artifact-store/score separation; **prove a second objective re-scoring the same artifacts with zero re-sim.** This is the proof of the entire thesis. (The fixed-weights response cache is explicitly NOT here; it waits on M5.)
- **M4 — Lane B + online canary validation.** Single-step counterfactual against the pinned model with `replay_class`-aware effect handling; a canary slice collecting *fresh* verdicts on a candidate's real outputs, weighted above all historical labels. The loop closes online-per-version.
- **M5 — Egress E1 + the model-call boundary (the cache prerequisite).** Two-stage on-device redaction, frozen consent, subject-partitioned crypto-shred, DP selection, the "what leaves" view; and the `ANTHROPIC_BASE_URL` proxy shim that finally captures the literal rendered prompt + decoding params, lighting up the fixed-weights response cache. First fleet data, privacy-sane.
- **M6+ (deferred) — Lane C checkpoints (opt-in), enclave E2/E3, federated re-sim.** Reserved; the end-state where bulk never centralizes.

---

## 9. Top open questions + the cheap experiment that resolves each

1. **Does the session JSONL contain anything usable for replay, and what exactly?** Resolution: a 5-minute read of one real `~/.claude/projects/<encoded>/<sid>.jsonl` from an `xhigh` resident session, field-by-field (thinking? tool_use inputs? any `usage`/model params?). This determines whether M3's `llm` capture is transcript-only (almost certainly yes) and confirms the cache must wait for M5's proxy. **Do this before committing M3.**
2. **Is the perception-constant search space (Lane A) where real leverage lives, or is it the prompt/harness behaviors that only surface in full Lane-B rollouts?** Resolution: in M1, run 5-10 hand-written coalescer variants against a week of one user's real `signal_raw` and measure wake-decision deltas against recorded moments. If the deltas are trivial, leverage is in the prompt tier and we reprioritize toward M4.
3. **What is the actual per-user-day volume, and what is the dominant term?** Resolution: instrument the existing page sensors for one real active hour (count raw events × avg digest size), `wc -c` a real `xhigh` JSONL over a session, and use the measured ~10-15 MB/active-hour frame number already in `telemetry.ts`. The SKEPTIC is right that the raw-signal firehose and reasoning traces dominate, not structured rows. This sets the cap/decimation policy and the E0 disk budget.
4. **Does the verdict attributor's same-surface-within-window heuristic actually bind reactions to the right decisions?** Resolution: hand-label 100 real human reactions against their true decisions and measure the attributor's precision/recall. If precision is poor, the corpus-first bet is weaker than claimed and we lean harder on programmatic effect-checks over human verdicts.
5. **Can the redactor de-identify content-agnostic page bytes well enough that E1 is defensible?** Resolution: run the NER scrubber over a day of one consenting user's real moments and have a human audit the residual re-identification risk. If it leaks, E1 ships structure-only (types/shapes/timing/verdicts, no scrubbed content) and we accept lower fidelity.
6. **Does the LLM judge's bias survive an ensemble, and does it favor its own family?** Resolution: score 50 trajectories with a Claude-family judge and a non-Claude judge under the same rubric; a large gap is the evaluator-Goodhart signal. This validates the held-out-judge rail before any campaign trusts the judge.

**Anti-Goodhart rails I am mandating (synthesizing IR-9 and the COMPLETENESS critique's deepest point), because the search is most judge-dependent exactly where it is most novel:** (a) a fixed fraction of every campaign's Pareto-frontier selections must be confirmed by a *fresh* human verdict sampled from the high-divergence/`judge-only` region; (b) finalists are scored with a *held-out judge* family, and a large train/holdout-judge gap is treated as gaming; (c) inject the do-nothing and maximally-conservative reference variants every campaign — if either reaches the frontier under the current objective, the *objective is mis-specified* (rewarding passivity), an automated gate, not a ship; (d) cap the LLM judge to *tie-breaking authority* below human-verdict and programmatic-effect signals, which bounds Goodhart by bounding the judge's authority — the one lever fully in our control.

---

## 10. What we are NOT doing yet, and why

We are not building literal model replay, the fixed-weights response cache, federated/on-device re-sim, the enclave deep-cohort, or Lane C free rollout in the first arc — and we are not pretending the autonomous loop edits the kernel. Literal model replay is structurally impossible (we do not own the call seam) and the cache that would exploit frozen weights requires first owning that seam via a proxy shim, which is an agent-runtime change we defer to M5 rather than promise as a capture freebie. Federated re-sim is the correct end-state but is the highest-cost, mostly-greenfield path (no FL/DP/PII-scrub/crypto-shred infra exists today), so we fund and de-risk the flywheel with a central *redacted* E1 corpus first and build toward federation, honestly accepting that until it lands the fleet optimizes over a redacted shadow of the real distribution and the central efficiency cache is bottlenecked to the small enclave cohort. We confine the autonomous loop to harness-as-data (prompts, tool specs, perception constants) because free-form kernel edits do not compile, deadlock CDP, or crash the host, and structural changes belong in human-reviewed PRs gated by the existing deterministic test suites. The discipline this defers nothing on: the on-device raw tape is a standing liability from the moment of capture (before egress is even considered), so encryption-at-rest, default-OFF, one-gesture deletion, crypto-shred keys, and the "what leaves this machine" legibility view are load-bearing from M0, not later polish.

---

**One-line derivation, end to end:** because the loop re-samples a frozen-weights model on recorded *situations* and re-scores stored *trajectories* under a *changing* objective, the tape is a boring, objective-agnostic, content-addressed ledger of facts — every action stamped with a stable `decision_id` bound to the moments that caused it, every byte tagged `env_in`/`agent_out` so the world is replayable, full args+result+snapshot+raw-signals captured losslessly *locally* with the model plane joined by reference and heavy bytes as redactable hash-pointers, every human reaction captured with origin/affordance/diff/latency and attributed *later* by a versioned attributor — egressing to the fleet only as a small, structured, DP-bounded, crypto-shreddable, per-record-consented subset, with objectives and scores living entirely off-device so a 2027 constraint is just a new judge re-run over 2026 tapes.

**Load-bearing files (all absolute):** `/Users/minjunes/superapp/teenybase/agent-os/src/main/os-tools.mjs` (`instrument`/`setToolTap`, lines 44-72 — the M0 widen + `decision_id` seam, all three transports), `/Users/minjunes/superapp/teenybase/agent-os/src/main/perception-core.mjs` (`ingestSignals` line 119 — the M1 `signal_raw` kernel tap; `setMomentTap`/`emit` lines 166-176; `isContentShared` — the frozen-consent seam), `/Users/minjunes/superapp/teenybase/agent-os/src/main/telemetry.ts` (the spool precedent + the *already-shipping moment egress to close in M0* + the clip-by-drop/snapshot-drop to amend), `/Users/minjunes/superapp/teenybase/agent-os/src/main/agent-runtime.mjs` (the JSONL path computed line 150, `claudeSessionId` in `meta.json` line 172, the `claude`/`codex` `--dangerously-skip-permissions` spawn lines 121/131 that captures no model I/O today — the M3 collector target and the M5 proxy-shim target), `/Users/minjunes/superapp/teenybase/agent-os/src/main/cdp.ts` (where CDP-injected input must be tagged `origin:tool`, GAP-5), `/Users/minjunes/superapp/teenybase/agent-os/src/main/control-core.mjs` (`diffEffect` — the length-proxy effect, named honestly), the three transports `agentSocket.ts` + `electron-os-tools.ts`/`control-server.ts` + `preview/backend.mjs`, and the spec to rewrite `/Users/minjunes/superapp/teenybase/agent-os/plans/research/session-tape-and-daydreaming.md`. New module: `/Users/minjunes/superapp/teenybase/agent-os/src/main/session-tape.mjs`.

Systems/papers cited (from my own knowledge; web search was unavailable in this run, verify before external citation): FunSearch (Romera-Paredes et al., Nature 2024), AlphaEvolve (DeepMind 2025), Darwin Gödel Machine (Zhang/Lu/Clune et al. 2025), GEPA (2025), OPRO (Yang et al. 2024), APE (Zhou et al. 2023), DPO (Rafailov et al. 2023), KTO (Ethayarajh et al. 2024), RLHF reward-model-from-preferences (Christiano et al. 2017; Stiennon et al. 2020), doubly-robust OPE (Dudík/Jiang/Li) and the curse of horizon (Liu et al. 2018), DAgger/compounding error (Ross & Bagnell 2011), reward-model overoptimization scaling (Gao et al. 2023), LLM-judge bias (Zheng et al. 2023; Panickssery 2024 on self-preference), counterfactual learning from logged bandit feedback (Joachims et al. 2018), inference nondeterminism (Thinking Machines 2025), WebArena (Zhou et al. 2023) + AndroidWorld (Rawles et al. 2024) for state-shaped path-independent scoring, MAP-Elites (Mouret & Clune 2015), ASHA/successive-halving (Li et al. 2020), OpenTelemetry span model + LangSmith run trees, Apache Iceberg/Delta Lake, crypto-shredding + differential privacy (Dwork) + DPIA, and the AI-Scientist reviewer-gaming incident (Sakana 2024).
