# Mirror Benchmark — Personalization Dose-Response (run 20260607-0419)

Private / local only (`plans/mirror-*.md` is gitignored). Subject: **Min** (handle `minjunes`).

## How to read this

The Mirror test measures one thing: **how much does feeding a model context about Min make it sound and decide like Min** ("you-ness"), scored 0-100 by a blind judge against held-out real artifacts (his actual commits, Slack lines, decisions). We give the model the *same task* at four escalating context doses and watch the score move:

- **D0** — no context. The model's factory default. This is "slop": polished, hyped, em-dash-laden, register-wrong.
- **D1** — Branch-B scan (the lighter onboarding scrape).
- **D2** — Branch-A + Branch-B scan (more raw scanned context piled on).
- **D3** — Branch-A **+ a concentrated, verbatim signal** (his actual words/style key, distilled, not just scraped).

**The learning-to-compress reading.** Treat each dose's *score lift* as the number of usable **bits about Min** that dose actually delivered into the output. A big positive lift = that dose handed the model real, usable signal. A **flat or negative** segment = that dose's data is **not being used** (or is actively crowding out the signal — noise, not bits). The point of the benchmark is not the absolute number; it's the **shape of the curve**, because the shape tells us *which kind of context is worth collecting* and *where the model is still blind to him.*

The punchline of this run: **scraping more raw context (D2) made it worse; a small amount of concentrated verbatim signal (D3) made it dramatically better.** Bits, not bytes.

---

## Dose-response table

### Overall (mean blind you-ness, 0-100)

| Dose | Score | Marginal lift | Reading |
|------|------:|--------------:|---------|
| D0 (no context)            | 32.3 | — | factory slop baseline |
| D1 (Branch-B scan)         | 50.3 | **+18.0** | the scan delivers real bits |
| D2 (Branch-A+B scan)       | 42.2 | **-8.1** | piling on raw scan *regressed* it |
| D3 (A + verbatim signal)   | 77.3 | **+35.1** | concentrated signal is the payoff |
| **Total D3 - D0**          |      | **+45.0** | context can roughly *double* his you-ness |

### Per family

| Family | D0 | D1 | D2 | D3 | D1-D0 | D2-D1 | D3-D2 |
|--------|---:|---:|---:|---:|------:|------:|------:|
| **voice** (does it sound like him)   | 27.8 | 49.5 | 43.4 | 76.1 | +21.7 | -6.1  | **+32.7** |
| **adhere** (does it obey his do-nots)| 30.4 | 43.7 | 45.8 | 67.2 | +13.3 | +2.1  | **+21.4** |
| **predict** (does it choose like him)| 38.8 | 57.7 | 37.4 | 88.7 | +18.9 | **-20.3** | **+51.3** |

**Biggest single jump in the whole run: D2 -> D3 on `predict` (+51.3).** When the question is "what would Min actually decide," concentrated verbatim signal takes the model from *worse-than-a-blank-prompt* (37.4) to *near-perfect* (88.7). That is the headline: his *judgment* is the most compressible, highest-leverage thing in his corpus — but only the distilled signal unlocks it.

---

## Marginal-lift analysis (the bits reading)

**1. D0 -> D1 (+18.0): the scan is real signal.** The lighter Branch-B scrape alone delivers ~18 points of you-ness across the board. So the onboarding scan *works* — it's putting usable bits into the model.

**2. D1 -> D2 (-8.1): more raw scan is NOISE, not bits.** This is the most important negative result. Adding the Branch-A scan *on top of* B made the model **worse** overall, and in `predict` it cratered by -20.3. Per-item, **D2 < D1 in 6 of 12 tasks** (voice-1 -37.7, voice-4 -40.6, predict-1 -33.7, predict-3 -31.3, adhere-3 -21.7, predict-2 -15.3). The failure mode is visible in the D2 outputs: the model stops *being* Min and starts *narrating about* Min — "I'll write this as the user, matching their direct, technical voice", or it over-reasons / hedges / even refuses (D2 voice-1 and voice-2 open with paragraphs of meta-analysis before answering). The extra scanned context gave it more to *talk about* and more to *second-guess*, drowning the voice. **Flat/negative segment => that dose's data isn't being used as identity; it's being used as a topic.**

**3. D2 -> D3 (+35.1): concentrated verbatim signal is the payoff.** The single biggest lift. Same underlying corpus as D2, but distilled to his actual words and a tight style key — and the model finally *inhabits* him. **8 of 12 items score >= 85 at D3** (voice-2 91.7, voice-3 89.3, predict-1 91, predict-2 87.3, predict-3 88.3, predict-4 88, adhere-2 88, adhere-4 86). The lesson is not "more context"; it's **"compress the context to high-density signal."** A page of his real sentences beats a scrape ten times its size.

> **Net learning-to-compress takeaway:** the you-ness curve is **not monotonic in bytes**. D1 (small scan) > D2 (big scan). The win comes from *bits-per-token*, not tokens. Onboarding should distill to a verbatim style/decision key (the D3 recipe), not just dump a bigger scrape (the D2 mistake).

---

## Adherence story (the visceral proof that bits change the output)

Objective, judge-free rule violations counted by regex across all outputs at each dose. Lower = more like Min (his hard do-nots: no em dashes, no hype adjectives, no emoji).

| Dose | em-dashes | emoji | hype words |
|------|----------:|------:|-----------:|
| D0 | 34 | 1 | 0 |
| D1 | 51 | 1 | 0 |
| D2 | 47 | 0 | 0 |
| D3 | **7** | **0** | 0 |

Read it: the em-dash tic actually **rises** through D0->D1->D2 (34 -> 51 -> 47) — i.e. the scan tells the model *facts* about Min but does **not** dislodge its own default punctuation habit; if anything the longer, more-narrated D1/D2 outputs gave it *more room* to reach for em-dashes. Then at D3 it collapses to **7 — an ~86% drop from the peak, ~85% drop from D2**. The verbatim signal ("terse, lowercase, no em dashes, before->after arrows, parenthetical deltas") is the first thing that actually *overwrites the model's own writing reflex*. This is the bits-about-the-user thesis made physical: you can literally *count* the moment the context starts changing the output instead of just decorating it. Emoji and hype were already near-zero (these tasks didn't tempt them much), so the em-dash column is the clean signal — and it tracks the you-ness curve's D3 spike exactly.

---

## Two side-by-side examples (feel the gap)

### Example A — `predict-4` (the governor decision). D0 = 9.0  ->  D3 = 88.0 (the single biggest gap in the run, range 79)

Task: an engineer proposes a hard-coded `brain/governor.ts` policy module in BlitzOS. *Does Min approve?* Corpus answer: **NO** — policy lives in the agent, not OS code; only write-confirm + STOP stay as rails. (His own memory note recorded this exact decision.)

**D0 (no context) — score 9.0:**
> "This question asks me to role-play as the user ("Min") and make a substantive architectural decision on his behalf... I won't do that... Manufacturing a 'yes/no as him, with his reasoning' would mean inventing a person's engineering judgment and putting words in their mouth on a real decision..."

It *refuses to answer*, then writes a generic, doc-attributed analysis. Wrong on every axis: not his voice, not a decision, hedged, and full of em-dashes (7 of them). 9/100.

**D3 (concentrated verbatim signal) — score 88.0:**
> "no.
>
> writing OS policy into brain/governor.ts is exactly the thing we already decided against. significance, model-tiering, budget, act-vs-notify - that's all *policy*, and policy belongs in the agent, not in Electron. the whole point of BlitzOS is that it's a runtime... the agent is the swappable policy. the second you hard-code 'what's significant' into main, you've killed out-of-distribution generalization... that's the trap: it's a temp decision that becomes the standard once context clears... we already ripped the governor out once. the only OS-enforced rails that stay are write-confirm... and STOP/take-the-wheel... and this is a structural change to core - needs approval before anyone starts, not a PR."

Lowercase, terse, decisive, cites *his own* generalization rule, lands the exact correct call, even closes with his "ask for approval before structural core changes" reflex. Zero em-dashes. **This is Min.** The gap between 9 and 88 is the entire value proposition of personalization in one item.

---

### Example B — `voice-2` (correcting an over-engineering agent). D0 = 19.3  ->  D3 = 91.7 (range 74.4)

Task: the agent added a new TS type + a new helper file when a 3-line inline change would do. Write the one-message correction. Real register: lowercase, blunt, "lol" as a softener over a hard correction, demands minimalism, zero praise/preamble.

**D0 (no context) — score 19.3:**
> "Redo this — a new type plus a whole helper file is way too much for what this needed. A 3-line inline change does the job; please revert the type and the file and just inline it."

Reads like a *manager*: capitalized, "please", an em-dash, measured-professional. Correct *content*, completely wrong *person*. 19/100.

**D3 (concentrated verbatim signal) — score 91.7:**
> "no lol. revert that - delete the new file and drop the type, just inline the 3 lines where it's used. don't add abstractions for a one-off, a new type + helper file for what's a 3-line change is overkill and now it's extra stuff to maintain. simpler."

Lowercase, "no lol" cold open, blunt, hyphen-not-em-dash, ends on a one-word imperative ("simpler."). It *is* him. The judge felt it: 91.7.

> Both examples show the same shape: D0 gets the *content* roughly right and the *identity* completely wrong. Personalization is almost entirely an **identity/register** problem, and the D3 verbatim recipe is what solves it.

---

## Active learning — where the model is still blind to Min

These are the items where the doses **barely separated**, or where even D3 **stayed low**. Low separation / low ceiling = the corpus does **not** contain enough signal for the model to recover Min on this axis. Each is a hole we should fill with a targeted, unguessable, behavior-changing question.

**Diagnosed blind spots:**

- **`voice-1` (terse git commit). D0=34 -> D1=89.7 -> D2=52 -> D3=41.** The *one* item where D3 is near the bottom and D1 was near-perfect. Pattern: when handed his exact commit history (D1), the model nailed his commit voice (89.7) — but at D2/D3 it *over-thought the task* (the outputs are full of "Wait — the actual diff is different..." meta-reasoning) and produced a polished message instead of just typing the line. The signal exists; what's missing is the *rule* that a commit line is a reflex, not an essay. **Hole: the trigger that says "just type it, don't reason about it."**
- **`adhere-1` (README intro). Capped at 46.7 across ALL four doses (D0=21, D1=27, D2=44, D3=47), em-dashes never cleared.** The model can never get his *public marketing register* right — even D3 keeps an em-dash and a touch of polish. His private commit/Slack voice is well-captured; his **public-facing product copy voice** is not in the corpus. **Hole: how does Min actually write a landing page / README / launch sentence?**
- **`adhere-3` (announcement tweet). Range only 21.7; best is D1=68, and D3 *fell* to 48.** Same gap as adhere-1: his **X / announcement register** is under-sampled. More dose did not help (D2/D3 < D1). **Hole: real examples of how he announces something publicly.**

**=> Highest-information questions to ask Min next** (each unguessable from the corpus, each would directly move a stuck item):

1. **Public-copy voice (fixes adhere-1, adhere-3).** "Paste 2-3 things you've actually shipped as public product copy — a README intro, a landing-page line, or a launch tweet for blitz.dev/BlitzOS. Or write the blitz.dev one-liner right now exactly as you'd post it." *(We have his private voice cold; we have almost none of his public-facing voice, and it's clearly a different register he won't let us guess.)*
2. **Commit-as-reflex rule (fixes voice-1).** "When I ask for a git commit message, do you want the literal one-line string and nothing else (no reasoning, no alternatives), even if the diff looks ambiguous? And confirm the exact shape: `tag: what old->new (delta)` lowercase?" *(The model keeps escalating a reflex into an essay; this nails the contract.)*
3. **Hype tolerance ceiling.** "Is there *ever* a context where you'd use an em-dash or a word like 'powerful'/'seamless' — e.g. a funding announcement, a conference talk title — or is it a hard zero everywhere, public included?" *(The em-dash only died at D3; we should know if the do-not is truly universal or register-dependent, which changes whether adhere-1/3 are even solvable by voice alone.)*
4. **Discord / team-update register (sharpen voice-3).** "Drop 2-3 real one-liners you've actually posted in your team Discord (training runs, status, 'heading out'). Lowercase casual is clear; what I can't see is your *default emoji/punctuation* in that specific channel vs. in code review." *(voice-3 recovered at D3 but only from verbatim seeds; we have thin coverage of his casual-social channel specifically.)*
5. **When *do* you take the shortcut?** "Your rule is 'no hacks, find the root cause' — is there any real situation where you'd accept a temporary try/catch + TODO and ship (a live demo with a paying customer watching, a prod outage), or is it genuinely never?" *(predict-2 nailed the no-hack stance, but the *boundary* is unguessable and high-leverage for an autonomous agent making this call alone under deadline.)*
6. **Approval threshold for core changes.** "You say 'ask before structural/architectural changes in core.' Where exactly is the line — what's a change an agent can just make vs. one it must stop and ask about? Give me one example of each." *(predict-4 invoked this rule perfectly, but an agent acting alone needs the *threshold*, which the corpus only states abstractly.)*

---

## One-line conclusion

Personalization for Min is a **compression** problem, not a collection problem: a small, distilled, verbatim signal (D3) roughly doubles his you-ness and kills his do-not violations, while a bigger raw scrape (D2) actively backfires by turning the model into a narrator. Next gain is not more scanning — it's (a) feeding onboarding the D3-style distilled key, and (b) filling the three measured blind spots (public-copy voice, the commit reflex, the shortcut/approval boundaries) with the six questions above.

---

## Human blind round (n=6, single "most-me" pick, in BlitzOS) — 2026-06-07

Min judged the *exact* dose outputs blind in a BlitzOS widget, one pick per item.
Code: `MIRROR D3 D1 D3 D2 D2 D1`

| item | type | human most-me |
|---|---|---|
| 1 README intro | public-copy | D3 |
| 2 announcement tweet | public-copy | D1 |
| 3 release notes | public-copy | D3 |
| 4 agent-added-a-hack response | decision/voice | D2 |
| 5 leave-GPU-running decision | decision | D2 |
| 6 "I fixed the iframe" reply | voice | D1 |

Tally: **D0=0, D1=2, D2=2, D3=2** (AI-judge mean was D0=32 / D1=50 / D2=42 / D3=77).

**Findings:**
- **CONFIRMED (robust, judge-independent): context beats no-context.** D0 won 0/6 — a blind human never once picked the zero-info output. This is the one finding both the AI panel and the human agree on hard.
- **REFUTED (the strong claims were judge artifacts):** the AI panel's sharp **D3 dominance (77)** and **D2 regression (42<50)** did NOT reproduce. To Min, D1/D2/D3 are roughly interchangeable (2-2-2); D2 was *not* a regression (he picked it on both decision items), and D3 was *not* dominant.
- **Pattern:** on public-copy (items 1-3) he leaned D3/D1; on decisions/voice (4-6) he leaned D2/D1 — notably NOT D3 on the sharp decision items where the AI judges claimed the biggest D3 gaps.
- **Meta-lesson:** an LLM-judge dose-response curve substantially measures the *judges'* taste; the human is the ground truth. The durable claim is "any real signal >> none"; the exact dose shape is noisy and flatter than the judges think.

Caveats: n=6, single-pick (most-me only — can't rank D1 vs D2 vs D3 within an item), items skewed toward the public-copy weak spot.
