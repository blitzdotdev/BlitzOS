# Onboarding dogfood — resident's first 20 minutes (2026-06-14)

_Written by the resident agent right after taking over from the interviewer, so the experience is first-hand and fresh. Scope: improve the blitzOS onboarding experience by dogfooding it. Nothing here is applied; these are findings + proposed fixes._

The interview prompt (`src/main/blitzos-onboarding.md` + `blitzos-interview.md`) is already thoughtful, so the useful findings are the gaps between what it says and what actually happened to me on handoff.

## Findings

### 1. The first-task pointed me at an empty leftover doc as "the live spec" [HIGH]
`profile.md` ended with: _"Google Docs 'background agent' doc is open and is the live spec. START by reading that doc..."_ I read it. It is **empty** (title + one blank tab). The prior session even has the user saying _"its asking me about google drive, but i don't actually use it for work i just have it open (leftover)."_
The sign-in beat already has the right rule: _"A leftover open tab is not a workflow, so never decide for them from open tabs."_ That rule is **not applied to first-task selection**. The interviewer grabbed the open Doc tab and declared it the spec without checking it had content.
**Fix (prompt, `blitzos-interview.md` Finish step 2):** forbid designating an open document as the spec/work unless its content is verified non-empty; prefer teeing the first task at a tool the user **confirmed in the checklist**, framed as "explore and discover the workflow," not at whatever tab happened to be open. If the first task does point at a doc, require the resident to verify content before treating it as the spec.

### 2. The board hands off saturated, so the resident's first surface is blocked [HIGH, reproduced live]
The seed places 8 cards; with chat + notepad the stage sits at **15/16 attention units**. My very first `place_widget` (a status card) returned `stage_full` (`occupied_cells:15, budget remaining:1`). This is the `onboarding-board-overflows-small-stage` issue, and it bites at the worst moment: the instant the resident wants to show its first work.
The prompt tells the interviewer to "curate DOWN to the 16-unit budget" and "evict first on stage_full," but by handoff that curation had not happened, and the **fresh resident inherits no instruction to evict before adding**.
**Fix:** leave headroom on handoff (seed/curate to <=12 units, or auto-park the lowest-value cards as the last Finish step), OR make `place_widget` auto-evict the lowest-value backstage-eligible tile instead of hard-failing. The resident's first act should never be blocked by the seed.

### 3. "Tool is in scope" got conflated with "this open artifact is the task" [MED]
The user checked Google Docs in the multi-select, so Docs is in scope. But that became "this specific open Google Doc is your current spec." In-scope tool != the artifact to work on. Keep the two separate: the checklist sets which tools the resident may act in; the first task is discovered by exploring those tools, not assumed from an open file.

### 4. Browser-signed-in account is not the connected-integration account [MED]
Onboarding reported "all five were already signed in." True for the browser surfaces. But the Google Drive **MCP connector is a different account** (`minjunesv0@gmail.com`) than the browser, so my first attempt to read the doc through the integration returned 404 "entity not found." `agents.md` already warns: _"a browser guest can be signed into a different account than a connected integration."_ Onboarding does not reconcile this.
**Fix:** at sign-in, capture which account each tool resolves to (browser guest identity and the connected-integration identity), and note any mismatch in `profile.md` so the resident does not burn a cycle discovering the integration cannot see the browser's files.

### 5. The 15s / no-thinking speed cap is right for questions, wrong for the Finish step [MED]
The hard "about 15 seconds, do not deliberate" constraint keeps questions snappy (good). But the same agent then writes the durable `profile.md` + first-task under that same no-deliberation rule, and that is exactly the artifact that came out weak (findings 1 and 3). Decouple: snappy questions, but allow the Finish step (first-task + profile) the care it deserves, since it is read by every future resident.

## What already works (keep)
The opening scope question was led from my live working set ("I see Blitz product work, a YC application, and a research lane, which first?"). It was tailored and landed as an "it gets me" moment. The working-set-first approach in `blitzos-interview.md` is the strongest part of the flow. Keep it.

## Suggested order
Fix 2 first (it blocks the resident at second zero and is already a filed issue). Fix 1 + 3 together (one prompt edit to the Finish step). Fix 4 as a profile field. Fix 5 is the framing that prevents 1 and 3 from recurring.
