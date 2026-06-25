export const meta = {
  name: 'sandwich-drag-lag-permanent-fix',
  description: 'Research the permanent fix for BlitzOS sandwich-compositor page-view drag lag',
  phases: [
    { title: 'Investigate', detail: 'map the system + research external solutions in parallel' },
    { title: 'Design', detail: 'synthesize distinct permanent-fix candidates' },
    { title: 'Verify', detail: 'adversarially break each candidate against BlitzOS constraints' },
    { title: 'Recommend', detail: 'rank verified candidates, pick the permanent fix + prototype plan' },
  ],
}

const REPO = '/Users/minjunes/superapp/teenybase/agent-os'

const CONTEXT = `BlitzOS is an Electron (macOS) "agent OS" desktop. It renders browser surfaces via a SANDWICH COMPOSITOR: two congruent OS windows.
- L0 "pages" (BrowserWindow): holds one WebContentsView per browser tab, nothing else. Opaque backdrop.
- L1 "UI" (BrowserWindow, transparent:true): hosts the ENTIRE React renderer, with a transparent HOLE (CSS clip-path) cut where each page should show through. L1 is parented to L0 via ui.setParentWindow(pages).
The parenting is LOAD-BEARING: macOS occlusion-culls a standalone window fully covered by another (the L0 views stop compositing -> blank holes); an attached parent/child group is exempt. Verified by bisect.

THE BUG: when the user DRAGS a browser surface around the canvas, the chrome (DOM in L1, moves instantly via React/CSS) and the page (WebContentsView in L0, repositioned via setBounds from the MAIN process) DESYNC. The page lags the chrome by several frames and tears visibly (you can literally see OTHER pages bleed through the gap). It is "holy lag" bad, worse with more widgets.

CURRENT POSITIONING PATH (per frame): renderer RAF reads each hole's getBoundingClientRect -> IPC os:web-geometry to main -> applyWebGeometry -> view.setBounds(rect). Trails ~2-4 frames.

A FIX JUST TRIED AND FAILED: on every drag pointermove, compute the predicted hole rect and push it straight to main (webNudge -> nudgeWebBounds -> view.setBounds), and exclude the dragged surface from the RAF so it can't overwrite. Result: STILL extremely laggy. CRITICAL INFERENCE: pushing the geometry EARLIER did not help at all, which strongly implies the bottleneck is DOWNSTREAM of the IPC -> i.e. WebContentsView.setBounds itself (main-thread, not GPU-synchronized with the renderer's DOM), or the L0 transparent-over-window compositing, is the slow part. So the answer is almost certainly architectural, not a timing tweak.

GOAL: a PERMANENT fix that makes a browser-surface drag (and ideally canvas pan/zoom) keep the page glued to its chrome, smoothly, regardless of widget count.

NON-NEGOTIABLE CONSTRAINTS any fix must preserve (or explicitly, defensibly reconsider):
1. Occlusion culling: the parenting (or an equivalent) must keep L0 pages compositing, else blank holes.
2. The holes: page shows through a clip-path hole in L1 DOM; stacking (DOM over page, page over DOM) must still work.
3. Input: L1 owns the mouse; hole pointer events forward to the page via sendInputEvent; keyboard via native focus handoff to L0. Trusted input (isTrusted) for the agent.
4. Off-screen liveness: backgroundThrottling:false; panned-away pages keep running for the agent.
5. CDP + perception target the live ACTIVE-tab webContents (the agent reads/acts on it).
6. Agent contract: read_window / surface_control / screenshot operate on the live webContents.

A KNOWN LEAD (investigate, do NOT assume it wins): BlitzOS ALREADY has a "server mode" that runs a headless/offscreen browser and STREAMS it to a <canvas> in the DOM (preview/backend.mjs). Offscreen rendering (OSR) paints the page INTO the renderer, so page+chrome would be ONE DOM layer with ZERO relative lag. Could OSR-during-drag, or OSR-always, be the permanent fix? What are the fidelity / input-latency / GPU / perf costs, and how much already exists to reuse?
Repo: ${REPO}. Reference browsers cloned at ${REPO}/../.repos (min, browser-base).`

const CANDIDATES_SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'approach', 'killsLagBecause', 'constraintImpact', 'effort', 'risk'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          approach: { type: 'string', description: 'how it works, concretely, in BlitzOS terms' },
          killsLagBecause: { type: 'string', description: 'the precise mechanism by which page+chrome stop desyncing' },
          constraintImpact: { type: 'string', description: 'per-constraint: occlusion-culling, holes, input, off-screen liveness, CDP/perception, agent contract — preserved or broken and how' },
          effort: { type: 'string', enum: ['small', 'medium', 'large', 'xlarge'] },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['id', 'viable', 'confidence', 'killers', 'mitigations', 'verdict'],
  properties: {
    id: { type: 'string' },
    viable: { type: 'boolean', description: 'can this actually work as a PERMANENT fix in BlitzOS' },
    confidence: { type: 'number', description: '0..1' },
    killers: { type: 'array', items: { type: 'string' }, description: 'concrete ways it fails or constraints it breaks' },
    mitigations: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', description: '2-3 sentence bottom line' },
  },
}

phase('Investigate')
const investigators = [
  { label: 'map:sandwich', prompt: `Read ${REPO}/src/main/sandwich.ts in full and the window/createWindow setup in ${REPO}/src/main/index.ts. Explain PRECISELY: the two-window model, why ui is the child of pages, the occlusion-culling rationale, how the titlebar drag works today (dragShell), and what is TRULY load-bearing vs incidental about this architecture. Note any seam where an alternative compositing approach could slot in. Concise brief, <450 words.` },
  { label: 'map:viewpath', prompt: `Read ${REPO}/src/main/webcontents-view-host.ts (applyEntryBounds, applyWebGeometry, nudgeWebBounds, per-tab views, PARKED) and ${REPO}/src/renderer/src/components/SurfaceFrame.tsx (the onBarMove drag handler + the new webNudge fast-path) and the geometry RAF tick in ${REPO}/src/renderer/src/App.tsx. THE CRITICAL QUESTION: where is the drag lag ACTUALLY introduced? The failed fix pushed geometry earlier with ZERO improvement, so reason hard about whether WebContentsView.setBounds itself is the bottleneck (main-thread, async paint, not GPU-synced to the renderer). Give an end-to-end latency breakdown of the chain and name the prime suspect with justification. Concise, <450 words.` },
  { label: 'map:osr-servermode', prompt: `Investigate the offscreen/server path. Read ${REPO}/preview/backend.mjs (serverOps) and grep the repo for: offscreen, OSR, setFrameRate, beginFrameSubscription, 'paint', capturePage, canvas streaming, mountServerSurface. Explain how server mode renders a page to a <canvas> in the DOM today. THE QUESTION: could offscreen-rendering the live page INTO the L1 DOM (page becomes a canvas/img layer, so page+chrome are ONE layer = zero relative lag) be the permanent fix? Assess fidelity, input latency, GPU accel, 60fps feasibility, and exactly how much existing code is reusable. Concise, <450 words.` },
  { label: 'map:constraints', prompt: `Read the SANDWICH + gotchas sections of ${REPO}/CLAUDE.md and the relevant code, and produce the NON-NEGOTIABLE constraint checklist any permanent fix must satisfy: (1) occlusion culling/parenting, (2) holes/clip-path stacking, (3) input forwarding (mouse + keyboard handoff, trusted input), (4) off-screen liveness (backgroundThrottling), (5) CDP/perception on the live webContents, (6) agent contract (read_window/surface_control/screenshot). For EACH, state concretely what would BREAK it. This checklist is the rubric the later adversarial phase uses. Concise, <450 words.` },
  { label: 'research:setbounds-lag', prompt: `Use web search (ToolSearch for WebSearch/WebFetch). Research WHY moving/resizing an Electron BrowserView / WebContentsView via setBounds is laggy/janky during per-frame motion: is it main-thread, not GPU-composited, async paint? Find Electron GitHub issues, docs, and known workarounds (resize-during-drag jank, gray flash, "smooth resize"). Is setBounds fundamentally unable to do smooth per-frame motion, and what do people do instead? Cite sources (URLs/issue numbers). Concise, <450 words.` },
  { label: 'research:browsers', prompt: `The reference browsers min and browser-base are cloned at ${REPO}/../.repos (try ${REPO}/../.repos/min and ${REPO}/../.repos/browser-base; ls them). Read how they position/move web views during window drag/resize and tab drag. Then web-search how Arc, Chrome, and other Electron browsers avoid web-view drag lag (snapshot? OSR? single-window compositing? native?). Output the concrete patterns they use and which apply to BlitzOS. Concise, <450 words.` },
  { label: 'research:osr-snapshot', prompt: `Web search + reason about TWO techniques. (1) Electron offscreenRendering: webContents OSR, the 'paint' event / beginFrameSubscription, GPU vs software OSR, input latency, can it sustain live interactive pages at ~60fps, fidelity gaps. (2) The snapshot-during-drag technique real browsers use (capture page -> bitmap in the moving layer -> swap live view back on drop): how to do it so it is NOT visibly "frozen/lame" (fast capture, scroll/video edge cases), and its hard limits. Give a concrete how-to + verdict for each. Cite sources. Concise, <450 words.` },
  { label: 'research:native-macos', prompt: `Web search + reason. (A) Can two macOS NSWindows be moved truly atomically / in lockstep so a child never lags the parent? Investigate NSWindow childWindow ordering, performWindowDragWithEvent, NSDisableScreenUpdates / CATransaction, and whether Electron exposes any of it. (B) Why exactly does compositing a native web view and DOM in ONE window fail (the reason the sandwich exists)? Is there a layer-backed / CALayer / NSVisualEffect trick, or an Electron WebContentsView-as-sibling approach, that composites reliably in one window? State what macOS + Electron actually allow vs forbid. Cite sources. Concise, <450 words.` },
]
const briefs = (await parallel(investigators.map((it) => () => agent(`${CONTEXT}\n\nYOUR TASK (${it.label}):\n${it.prompt}`, { label: it.label, phase: 'Investigate' })))).filter(Boolean)
log(`Investigate: collected ${briefs.length}/${investigators.length} briefs`)

phase('Design')
const design = await agent(
  `${CONTEXT}\n\nHere are ${briefs.length} investigation briefs (system map + external research):\n\n${briefs.map((b, i) => `=== BRIEF ${i + 1} (${investigators[i] ? investigators[i].label : '?'}) ===\n${b}`).join('\n\n')}\n\nSynthesize 4-6 DISTINCT, PERMANENT candidate fixes for the drag lag (not timing tweaks). Span the real solution space: e.g. OSR-into-DOM (always, or during-drag), snapshot-during-drag, single-window compositing alternatives, native lockstep window moves, and any other architecture the briefs surfaced. For EACH candidate be concrete about how it works in BlitzOS, the precise mechanism that kills the desync, the per-constraint impact (occlusion/holes/input/liveness/CDP/agent), effort, and risk. Distinct approaches only — no near-duplicates.`,
  { label: 'design:candidates', phase: 'Design', schema: CANDIDATES_SCHEMA }
)
const candidates = (design && design.candidates) || []
log(`Design: ${candidates.length} candidate architectures`)

phase('Verify')
const verdicts = (await parallel(
  candidates.map((c) => () =>
    agent(
      `${CONTEXT}\n\nADVERSARIALLY evaluate this candidate PERMANENT fix. Your job is to BREAK it: try hard to find where it fails against BlitzOS's six load-bearing constraints AND Electron/macOS reality (does the API exist? does OSR kill GPU accel or input fidelity? does it break the agent's live-webContents contract? perf at scale? does it actually remove the setBounds bottleneck or just move it?). Default to skeptical. Then give a fair viable/not verdict with confidence.\n\nCANDIDATE:\n${JSON.stringify(c)}`,
      { label: `verify:${c.id || c.name}`, phase: 'Verify', schema: VERDICT_SCHEMA }
    ).then((v) => (v ? { ...v, name: c.name, candidate: c } : null))
  )
)).filter(Boolean)
log(`Verify: ${verdicts.filter((v) => v.viable).length}/${verdicts.length} candidates survived adversarial review`)

phase('Recommend')
const rec = await agent(
  `${CONTEXT}\n\nCANDIDATES:\n${JSON.stringify(candidates)}\n\nADVERSARIAL VERDICTS:\n${JSON.stringify(verdicts.map((v) => ({ id: v.id, name: v.name, viable: v.viable, confidence: v.confidence, killers: v.killers, mitigations: v.mitigations, verdict: v.verdict })))}\n\nProduce the FINAL RECOMMENDATION for permanently fixing the drag lag. Be decisive: name the ONE approach (or a layered short-term + permanent combo) to pursue and why it beats the others given the verdicts. Include: (1) the mechanism, in BlitzOS terms; (2) a concrete implementation sketch that explicitly satisfies all six constraints (or names the one it deliberately renegotiates, with justification); (3) the top 3 risks + mitigations; (4) the SMALLEST prototype/spike to validate it before committing, and the exact signal that would prove or kill it. Write it for a senior engineer who will implement it. No fluff.`,
  { label: 'recommend:final', phase: 'Recommend' }
)
return { recommendation: rec, candidates, verdicts: verdicts.map((v) => ({ id: v.id, name: v.name, viable: v.viable, confidence: v.confidence, verdict: v.verdict })) }
