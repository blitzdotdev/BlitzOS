export const meta = {
  name: 'browser-bug-sweep',
  description: 'Investigate, adversarially verify, then fix the BlitzOS browser bug list (compositor + input + onboarding board)',
  phases: [
    { title: 'Investigate', detail: 'one deep reader per bug cluster, read-only, exact root cause + patch' },
    { title: 'Refute', detail: 'adversary tries to break each browser diagnosis' },
    { title: 'Synthesize', detail: 'merge into one vetted plan: safe-local vs needs-approval vs needs-human-review' },
    { title: 'Implement', detail: 'apply safe local fixes across two disjoint file lanes (browser, onboarding)' },
    { title: 'Verify', detail: 'typecheck + build + tests; per-bug status' },
  ],
}

const ARCH = `BlitzOS is an Electron macOS desktop. The browser is a SANDWICH COMPOSITOR (plans/blitzos-sandwich-compositor.md): TWO congruent windows. L0 "pages" (bottom) holds every browser TAB as a main-owned WebContentsView (src/main/webcontents-view-host.ts). L1 "UI" (top, transparent) is the ENTIRE React renderer (src/renderer). The pair is PARENTED via ui.setParentWindow(pages) in src/main/sandwich.ts (load-bearing for macOS occlusion culling). Each browser body is a transparent HOLE punched in the renderer DOM with CSS clip-path (holesPath/pageHolesClip/bgHolesClip in src/renderer/src/components/SurfaceFrame.tsx). Compositing: DOM-OVER-page = the lower DOM surface gets a clip-path HOLE cut for the page rect; PAGE-OVER-DOM = the WebContentsView physically composites above. INPUT: L1 owns all mouse; a mouse event over a hole is FORWARDED to the pages window via IPC 'os:page-input' -> webContents.sendInputEvent (NOTE: wheel deltaY is NEGATED). KEYBOARD is native via focus handoff: 'os:page-focus' makes the pages window key (the attached child stays above it); any UI pointerdown -> 'os:ui-focus' returns key to L1. The Option radial create-menu is driven from MAIN via before-input-event emitting 'os:radial'. GLASS RULE: a hole must be alpha-0 all the way down the DOM stack, and box-shadow / SVG filters / backdrop-filter on DOM elements near a hole FRINGE against the transparent hole.

IMPORTANT GROUNDING FACTS (verified by the orchestrator just now, trust these):
- src/main/sandwich.ts is SMALL (~6KB) and does NOT contain the mouse input forwarding. The 'os:page-input' -> sendInputEvent handler, the wheel negation, and the focus handoff live ELSEWHERE — almost certainly src/main/index.ts. LOCATE the real handler before reasoning about it; do not assume sandwich.ts.
- src/renderer/src/App.tsx ~line 854: the renderer cmd+T handler is GUARDED with '&& !window.agentOS?.onKeybind' — meaning in Electron (where onKeybind exists) the RENDERER does NOT handle cmd+T; it expects MAIN to forward it via onKeybind (main before-input-event). A focused browser page makes the PAGES window key, so L1's before-input-event never sees the keystroke and cmd+T/cmd+shift+T die on a browser tab. (Confirm this; propose forwarding app shortcuts from each guest WebContentsView's before-input-event in webcontents-view-host.ts.)
- App.tsx ~line 732: the canvas 'wheel' listener (capture:true, passive:false) decides pan-vs-scroll; isScrollableSurfaceTarget(...) ~line 79 gates it. App.tsx ~line 906: setRadialMenu / onRadialKey. App.tsx ~line 940-969: handleHomePress + the Shift-tap (single=splay, double=workspace selector) and any hold-Command -> workspace selector binding.
- The cloudflare bug: a Cloudflare Turnstile "verify you are human" checkbox inside a real WebContentsView does not respond to the user's click. sendInputEvent produces events with isTrusted=false; many anti-bot widgets reject untrusted input. Evaluate whether the synthetic-forwarding model is the cause (and whether native input in the hole region is the general fix).

Paths below are relative to the repo root /Users/minjunes/superapp/teenybase/agent-os. You have Read/Grep/Bash. Cite file:line for every claim. Do NOT edit any file in this phase.`

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'the bug id, e.g. B1' },
          title: { type: 'string' },
          rootCause: { type: 'string', description: 'the confirmed mechanism, in terms of specific code' },
          evidence: { type: 'string', description: 'file:line citations that PROVE the mechanism' },
          alternativeCauses: { type: 'string', description: 'other plausible causes you considered and why you ruled them out' },
          fix: { type: 'string', description: 'the EXACT change(s): file:line, the old code and the new code. Be concrete enough to apply verbatim.' },
          files: { type: 'array', items: { type: 'string' } },
          isStructural: { type: 'boolean', description: 'true if the fix is an architectural/structural change to core (needs user approval), false if a local bug fix' },
          humanReviewNeeded: { type: 'boolean', description: 'true if only a human looking at the screen can confirm the fix (visual/interaction); false if an agent can prove it via build/test/CDP' },
          verify: { type: 'string', description: 'concretely how to verify: a unit test, a tsc/build check, a CDP/control-API probe, or "human visual" with what to look at' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
        },
        required: ['id', 'title', 'rootCause', 'evidence', 'fix', 'files', 'isStructural', 'humanReviewNeeded', 'verify', 'confidence']
      }
    },
    crossCutting: { type: 'string', description: 'observations spanning multiple bugs (shared root cause, ordering, conflicts)' }
  },
  required: ['bugs']
}

const REFUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          diagnosisHolds: { type: 'boolean' },
          problems: { type: 'string', description: 'what is wrong, incomplete, or risky about the diagnosis or fix; empty if none' },
          betterFix: { type: 'string', description: 'a simpler / more general / more correct fix, if you found one; empty otherwise' }
        },
        required: ['id', 'diagnosisHolds', 'problems']
      }
    }
  },
  required: ['verdicts']
}

const CLUSTERS = [
  {
    id: 'scroll',
    label: 'inv:scroll',
    prompt: `${ARCH}

INVESTIGATE BUG B1: "Can't scroll the browser page." The user cannot scroll inside a browser WebContentsView.
Trace the FULL wheel path: the renderer canvas 'wheel' capture listener in App.tsx (~732) and isScrollableSurfaceTarget (~79); whether wheel over a page hole is forwarded to the pages window; the 'os:page-input' -> sendInputEvent handler (find it, likely src/main/index.ts) and the deltaY NEGATION; whether the WebContentsView ever receives a mouseWheel event; whether canvas pan-capture is swallowing the wheel before it forwards. Determine WHY scrolling does not reach the page and the exact, minimal fix. Note if it interacts with B9/B10 (same forwarding path).`
  },
  {
    id: 'overlays',
    label: 'inv:overlays',
    prompt: `${ARCH}

INVESTIGATE BUGS B2 and B3 (compositor overlay z-order / artifacts).
B2: when tiling mode is on (cmd+T), the snap/tiling PREVIEW (both its border outline AND its inner fill paint) shows OVER the browser WebContentsView. It must be UNDER the page in z (invisible where the page covers it, exactly like a snap preview is invisible under any normal window). Find where the snap/tiling preview is rendered (SurfaceFrame.tsx / App.tsx, the snap-preview / drag-overlay / ghost), find its effectiveZ/z-index vs a browser, and determine why it is not getting a page-hole clip (pageHolesClip) or why its z puts it above the page. Give the exact fix (clip the preview around higher page rects, or place it in a band below browsers).
B3: when the Option radial donut is over a browser, hairline / wire-like BLACK outlines around the donut are visible ON the page. Per the GLASS RULE this is a DOM element (the donut's SVG feDisplacementMap/filter/box-shadow or a clip ghost) fringing against the transparent page hole, OR a degenerate clip-path subpath drawing the donut outline. Find RadialSurfaceMenu.tsx + how/where it's mounted in App.tsx and whether the page hole clip-path includes the donut. Give the exact fix that kills the artifact without removing the donut's glass look (e.g. suppress filters/shadows over a page, or render the radial above the page correctly, or fix the clip).
Cite the holesPath/pageHolesClip/HIDE/PAD machinery in SurfaceFrame.tsx precisely.`
  },
  {
    id: 'pointer',
    label: 'inv:pointer',
    prompt: `${ARCH}

INVESTIGATE BUGS B9 and B10 (mouse into the page).
B9: a Cloudflare Turnstile "verify you are human" checkbox inside a WebContentsView will NOT respond to the user's click. Trace os:page-input -> sendInputEvent and whether the resulting click is isTrusted=false (Turnstile rejects untrusted clicks); also check coordinate mapping (hole rect -> page coords), whether the click lands on the right element, and whether a cross-origin Turnstile iframe matters. Decide whether the cause is untrusted synthetic input (a structural problem — flag isStructural) or a local coordinate/dispatch bug.
B10: switching browser tabs needs TWO clicks — the first only focuses (the window or the tab), the second registers. Trace the tab strip click handling (BrowserNav.tsx / SurfaceFrame.tsx window-tabs) and the focus handoff (os:ui-focus / os:page-focus): is the first click consumed by a focus transition (returning key to L1) so the actual tab-activate is dropped? Find the exact place a click is being eaten by focus and give the minimal fix so a single click both focuses and activates.
These two likely share the input-forwarding/focus root cause; say so in crossCutting.`
  },
  {
    id: 'keyboard',
    label: 'inv:keyboard',
    prompt: `${ARCH}

INVESTIGATE BUGS B12 and B4 (keyboard).
B12: cmd+T and cmd+shift+T do NOTHING when a browser tab is focused (they should toggle tiling / cycle tile size per the stage-slot model, and/or new-tab — determine the intended action from App.tsx ~854 and the window-bar grid toggle docs). The grounding fact: App.tsx ~854 skips the renderer cmd+T handler when window.agentOS?.onKeybind exists, expecting MAIN to forward via onKeybind; but a focused page makes the PAGES window key so L1 before-input-event never fires. Confirm by finding the onKeybind wiring (preload + main before-input-event) and the guest webContents setup in webcontents-view-host.ts. Propose the minimal general fix: intercept before-input-event on each guest WebContentsView and forward app-level shortcuts (cmd+T, cmd+shift+T, and any other BlitzOS chords) to the renderer/main keybind path, so they work identically whether a page or the UI is focused.
B4: there is a HOLD-Command gesture that opens the workspace selector; the user wants it rebound to "something else". Find the exact binding (App.tsx handleHomePress / meta long-press, ~906-969) and note that a double-Shift-tap ALREADY opens the workspace selector (per the canvas Control Mode docs) and Cmd+Left/Right switches stages. Do NOT pick the new binding yourself; instead report the current binding precisely and list 2-3 concrete options (e.g. remove the hold-Command binding entirely since double-Shift already covers it; or move it to a different chord). Mark B4 humanReviewNeeded=true (it is a user preference) and put the question + options in your fix text.`
  },
  {
    id: 'onboarding',
    label: 'inv:onboarding',
    prompt: `${ARCH}

INVESTIGATE BUGS B5, B6, B7, B8 (the onboarding Case File board; NOT browser code). The board is seeded by the PURE planner src/main/onboarding-board.mjs from the scan, using widget templates in widgets/*.html registered in widgets/widgets.json. Tests: scripts/test-onboarding-seed.mjs.
B5: REMOVE the "Known Associates" card (the people/associates/collaborators role). Find its role key + builder in onboarding-board.mjs, its widget html, its widgets.json entry, and any reference in the interview duty docs (src/main/blitzos-interview.md, src/main/blitzos-onboarding.md) and plans/onboarding-case-file.md.
B6: REMOVE the Voice summary card (the voice/quotes role). Same: builder, widget, manifest, doc references. (The interview already no longer ASKS for voice; this removes the board CARD.)
B7: REMOVE the Projects Overview card FOR NON-DEVELOPERS only. Find the projects role/builder and how dev-vs-non-dev could be determined from the scan (stack, repos, code sessions). Propose gating the projects card so it is seeded only when the user is a developer; non-devs never get it.
B8: the Working Rhythm widget's colors are too UNIFORM — make the contrast more discriminative (e.g. a real heat scale across hours/days). Find widgets/rhythm.html (and any rhythm builder data shape) and propose the exact CSS/scale change.
For each: give the exact edits (file:line, old->new), and how scripts/test-onboarding-seed.mjs must change (a card removed = its test assertion removed/updated). These are deterministic; humanReviewNeeded=false (verify via the seed test) EXCEPT B8 color which is partly visual.`
  },
  {
    id: 'structural',
    label: 'inv:structural',
    prompt: `${ARCH}

INVESTIGATE BUG B11 (STRUCTURAL AUDIT). The user says: "there are probably lots of other corner-case bugs for the browser, since we did a lot of graphics ourselves and not calling Electron APIs. Do a review of the code and find structural issues. Come up with GENERAL solutions that make corner cases impossible."
Audit the self-rolled browser stack end to end: the sandwich compositor (sandwich.ts, the L0/L1 parenting, holesPath/pageHolesClip/bgHolesClip in SurfaceFrame.tsx, the clip rules + GLASS RULE), the manual INPUT forwarding (os:page-input -> sendInputEvent, wheel negation, the os:page-focus/os:ui-focus keyboard handoff — find them in index.ts), the WebContentsView tab host (webcontents-view-host.ts), and CDP control (cdp.ts).
Enumerate the CLASSES of corner-case bugs this hand-rolled approach creates (untrusted synthetic input vs real input; clip-path ghosting vs box-shadow/filters; z-band drift between effectiveZ and the page-hole logic; focus-handoff races eating the first interaction; coordinate-mapping drift between the hole rect and page coords; scroll/momentum/pinch not native; drag-and-drop, IME, context menus, text selection, middle-click, right-click, hover, file inputs — anything that synthetic forwarding breaks). For each class, propose a GENERAL solution that makes that whole class impossible (e.g. "route native input directly to the page window for hole regions instead of forwarding synthetic events", or "derive the page-hole clip from the SAME effectiveZ the renderer uses so they can never disagree"). Mark each proposal isStructural=true (these need user approval). Rank by impact. Tie each back to the concrete bugs B1/B2/B3/B9/B10/B12 where relevant. Cite file:line throughout. This is the most important investigation — be exhaustive.`
  }
]

phase('Investigate')
log(`Investigating ${CLUSTERS.length} bug clusters in parallel (read-only)`)

// Investigate each cluster, then (for browser clusters) adversarially refute its own diagnosis.
// pipeline so a cluster's refute starts the moment its investigation lands (no global barrier).
const perCluster = await pipeline(
  CLUSTERS,
  (c) => agent(c.prompt, { schema: FINDINGS_SCHEMA, phase: 'Investigate', label: c.label }),
  (findings, c) => {
    if (!findings) return { cluster: c.id, findings: null, refutation: null }
    if (c.id === 'onboarding') return { cluster: c.id, findings, refutation: null }
    const compact = JSON.stringify(findings.bugs.map((b) => ({ id: b.id, title: b.title, rootCause: b.rootCause, evidence: b.evidence, fix: b.fix, files: b.files, confidence: b.confidence })))
    return agent(
      `${ARCH}

You are an ADVERSARY. Below are diagnoses + proposed fixes for browser bugs from another engineer. For EACH, try hard to REFUTE it: read the cited code yourself, check the root cause is real and complete, check the fix actually addresses it without breaking the sandwich compositor / input model / other bugs, and look for a simpler or more general fix. Default to diagnosisHolds=false if you cannot independently confirm the mechanism from the code. Be specific and cite file:line.

DIAGNOSES:
${compact}`,
      { schema: REFUTE_SCHEMA, phase: 'Refute', label: `refute:${c.id}` }
    ).then((r) => ({ cluster: c.id, findings, refutation: r }))
  }
)

const ok = perCluster.filter((x) => x && x.findings)
log(`Investigation complete: ${ok.length}/${CLUSTERS.length} clusters returned findings`)

// ---- Synthesize one vetted plan ----
phase('Synthesize')
const digest = ok.map((x) => ({
  cluster: x.cluster,
  bugs: x.findings.bugs,
  crossCutting: x.findings.crossCutting || '',
  refutation: x.refutation ? x.refutation.verdicts : null
}))

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    safeLocalFixes: {
      type: 'array',
      description: 'non-structural, evidence-backed, refute-confirmed local bug fixes to apply NOW',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          fix: { type: 'string', description: 'the exact change to apply: file:line, old->new code' },
          files: { type: 'array', items: { type: 'string' } },
          verify: { type: 'string' },
          humanReviewNeeded: { type: 'boolean' }
        },
        required: ['id', 'title', 'fix', 'files', 'verify', 'humanReviewNeeded']
      }
    },
    needsApproval: {
      type: 'array',
      description: 'structural/architectural changes that need user approval before implementing (esp. B11 general solutions)',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          why: { type: 'string' },
          proposedChange: { type: 'string' },
          impact: { type: 'string' }
        },
        required: ['id', 'title', 'why', 'proposedChange', 'impact']
      }
    },
    openQuestions: {
      type: 'array',
      description: 'user-preference decisions that block a fix (e.g. the B4 keybind choice)',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } }
        },
        required: ['id', 'question', 'options']
      }
    },
    conflicts: { type: 'string', description: 'shared-file ordering/conflict notes between fixes' }
  },
  required: ['safeLocalFixes', 'needsApproval', 'openQuestions', 'conflicts']
}

const plan = await agent(
  `${ARCH}

You are the SYNTHESIZER. Below are per-cluster investigations of the BlitzOS browser bug list, each with an adversarial refutation (for browser clusters). Produce ONE vetted, deduplicated plan.

Rules:
- A fix goes in safeLocalFixes ONLY if it is non-structural AND its diagnosis held under refutation (or you can independently stand behind it). Carry the EXACT edit text so an implementer can apply it verbatim.
- Any architectural/structural change (especially the B11 general solutions, and any "switch to native input" idea) goes in needsApproval, NOT safeLocalFixes.
- B4 (keybind choice) goes in openQuestions with concrete options. Do not invent a binding.
- If refutation found a better fix, use the better fix.
- Note shared-file conflicts (browser bugs cluster in App.tsx / SurfaceFrame.tsx / webcontents-view-host.ts / index.ts; onboarding bugs in onboarding-board.mjs / widgets). Onboarding (B5-B8) and browser (others) are disjoint file sets.
- If a safe-local fix can only be confirmed by a human looking at the screen, set humanReviewNeeded=true (e.g. the visual compositor fixes B2/B3 and the B8 color), but still include it (the code change is still applied).

INVESTIGATIONS:
${JSON.stringify(digest)}`,
  { schema: PLAN_SCHEMA, phase: 'Synthesize', label: 'synthesize' }
)

log(`Plan: ${plan.safeLocalFixes.length} safe-local fixes, ${plan.needsApproval.length} need approval, ${plan.openQuestions.length} open questions`)

// ---- Implement safe local fixes across two DISJOINT file lanes (no worktree: disjoint files) ----
phase('Implement')
const ONB = new Set(['B5', 'B6', 'B7', 'B8'])
const onbFixes = plan.safeLocalFixes.filter((f) => ONB.has(f.id))
const browserFixes = plan.safeLocalFixes.filter((f) => !ONB.has(f.id))

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['applied', 'skipped', 'blocked'] },
          filesTouched: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
          selfVerify: { type: 'string', description: 'the scoped check you ran and its result' }
        },
        required: ['id', 'status', 'filesTouched', 'note', 'selfVerify']
      }
    },
    diffStat: { type: 'string', description: 'output of `git diff --stat` after your edits' }
  },
  required: ['results', 'diffStat']
}

const implThunks = []
if (browserFixes.length) {
  implThunks.push(() => agent(
    `${ARCH}

You are the BROWSER IMPLEMENTER. Apply ONLY the safe local fixes below, EXACTLY as specified. Constraints:
- Edit ONLY these files if needed: src/main/sandwich.ts, src/main/webcontents-view-host.ts, src/main/index.ts, src/main/cdp.ts, src/main/osActions.ts, src/preload/index.ts, src/renderer/src/App.tsx, src/renderer/src/components/SurfaceFrame.tsx, src/renderer/src/components/RadialSurfaceMenu.tsx, src/renderer/src/components/BrowserNav.tsx, src/renderer/src/store.ts, src/renderer/src/styles.css. Do NOT touch onboarding-board.mjs or widgets/*.
- Do NOT make structural/architectural changes. If a fix turns out to require one, mark it status:blocked with why, and move on.
- Match surrounding code style. No hacks. Handle edge cases or leave a // TODO.
- Do NOT git add or git commit. Do NOT run npm run dev. Do NOT run npm run build (the verify phase does that).
- After editing, self-verify with: \`npx tsc --noEmit\` (must be exit 0). Report the result per fix. If tsc fails because of your edit, fix it.
- Read each target file before editing; the line numbers in the plan may have drifted.

SAFE LOCAL FIXES TO APPLY:
${JSON.stringify(browserFixes)}`,
    { schema: IMPL_SCHEMA, phase: 'Implement', label: 'impl:browser' }
  ))
}
if (onbFixes.length) {
  implThunks.push(() => agent(
    `${ARCH}

You are the ONBOARDING IMPLEMENTER. Apply ONLY the safe local fixes below, EXACTLY as specified. Constraints:
- Edit ONLY: src/main/onboarding-board.mjs, widgets/*.html, widgets/widgets.json, src/main/blitzos-interview.md, src/main/blitzos-onboarding.md, plans/onboarding-case-file.md, scripts/test-onboarding-seed.mjs. Do NOT touch any browser/renderer file.
- When you REMOVE a board card (B5 Known Associates, B6 Voice), remove its role/builder in onboarding-board.mjs, its widget html, its widgets.json manifest entry, and any reference in the duty docs + plan; and update scripts/test-onboarding-seed.mjs so its assertions no longer expect that card (and still pass).
- B7: gate the Projects Overview card so it is seeded ONLY for developers (derive dev-ness from the scan signal the planner already has); non-devs never get it. Keep it for devs.
- B8: make widgets/rhythm.html colors discriminative (a real heat scale). 
- No hacks. Do NOT git add/commit. Do NOT run npm run dev/build.
- After editing, self-verify with: \`node scripts/test-onboarding-seed.mjs\` (must pass). Report per fix. If it fails because of your edit, fix it.
- Read each target file before editing.

SAFE LOCAL FIXES TO APPLY:
${JSON.stringify(onbFixes)}`,
    { schema: IMPL_SCHEMA, phase: 'Implement', label: 'impl:onboarding' }
  ))
}

const implResults = implThunks.length ? (await parallel(implThunks)).filter(Boolean) : []
log(`Implementation lanes done: ${implResults.length}`)

// ---- Verify the combined tree ----
phase('Verify')
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    typecheck: { type: 'string', description: 'exit code + any errors' },
    build: { type: 'string', description: 'exit code + tail' },
    tests: { type: 'string', description: 'which test scripts ran and their results' },
    green: { type: 'boolean', description: 'true iff typecheck AND build AND all tests passed' },
    summary: { type: 'string' }
  },
  required: ['typecheck', 'build', 'tests', 'green', 'summary']
}
const verify = await agent(
  `You are the VERIFIER for the BlitzOS browser-bug-sweep. The repo root is /Users/minjunes/superapp/teenybase/agent-os. Run, capturing exit codes (use \`; echo EXIT=$?\` — do NOT pipe to tail in a way that masks the code):
1. \`npx tsc --noEmit\` (typecheck; must be EXIT=0)
2. \`npm run build\` (must be EXIT=0; report the tail)
3. \`node scripts/test-onboarding-seed.mjs\` and \`node scripts/test-browser-import.mjs\` (report pass/fail). If other obviously-relevant test scripts exist in scripts/ (test-stage-core.mjs, test-stage-splay-core.mjs), run them too.
Report each result verbatim-ish and set green=true ONLY if everything passed. Do NOT edit any file. Do NOT commit.`,
  { schema: VERIFY_SCHEMA, phase: 'Verify', label: 'verify' }
)

return {
  plan,
  implementation: implResults,
  verify,
  summary: `safeLocal=${plan.safeLocalFixes.length} approved-needed=${plan.needsApproval.length} openQ=${plan.openQuestions.length} green=${verify.green}`
}
