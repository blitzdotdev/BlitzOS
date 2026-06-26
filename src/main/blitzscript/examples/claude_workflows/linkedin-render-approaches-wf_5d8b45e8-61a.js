export const meta = {
  name: 'linkedin-render-approaches',
  description: 'Design + stress-test ways to reliably render custom UI inside a hostile auth-walled SPA (LinkedIn) in a BlitzOS web surface without tripping its anti-bot redirect',
  phases: [
    { title: 'Design', detail: 'parallel: one agent per injection/stealth approach, grounded in the codebase' },
    { title: 'Synthesize', detail: 'rank the approaches, pick a concrete build plan' },
    { title: 'Stress', detail: 'skeptics hunt for why the recommended plan will fail' },
  ],
}

const GOAL = `GOAL: make it possible to render ARBITRARY custom UI (our own HTML/CSS, as an overlay or a full replacement of the page) INSIDE a BlitzOS \`web\` surface that points at a hostile, auth-walled SPA (LinkedIn), RELIABLY, without tripping LinkedIn's anti-automation, which redirects the <webview> to a challenge page (observed: it bounced to https://cs.ns1p.net/u.html?a=...#check the moment we did automated reads).

SYSTEM CONTEXT (BlitzOS is an Electron app; a \`web\` surface is an Electron <webview> guest on partition 'persist:agentos', so the user is really logged in):
- Injection today happens two ways: (1) webContents.executeJavaScript via read_window's optional \`script\` param (localhost only); (2) CDP via webContents.debugger (surface_control uses Input.dispatchMouseEvent/dispatchKeyEvent/insertText, Runtime.evaluate, Page.captureScreenshot).
- The PERCEPTION layer injects sensors into every web surface and POLLS it every 350ms via executeJavaScript (a "DRAIN" call) to collect signals. This continuous scripted activity + the CDP debugger attach is the prime suspect for tripping the bot-redirect. A prior agent reported that switching to "reading passively" (no active polling) avoided the redirect.
- KNOWN GAPS today: no webContents.insertCSS usage; no preload script on web <webview>s; no CDP Page.addScriptToEvaluateOnNewDocument; no accessibility-tree read.

YOUR CONSTRAINTS: READ-ONLY research. Read the codebase to ground your design; cite file:line. Do NOT run the app and do NOT touch the live BlitzOS instance or its localhost control API — a live LinkedIn surface is open and must not be disturbed. (You MAY use web search where your approach needs external facts, e.g. bot-detection signals.)

KEY FILES TO READ: src/main/cdp.ts (the CDP adapter + debugger lifecycle), src/main/osActions.ts (find INJECT, osReadWindow, webviewIds, the os:register-webview handler, captureIntervals + the 350ms DRAIN loop, osControlSurface), src/main/perception-core.mjs (the sensor INJECT script + DRAIN cadence + what it observes), src/renderer/src/components/SurfaceFrame.tsx (the <webview> element, its attributes/webpreferences, dom-ready, reportWebview/registerWebview), src/main/index.ts (webview webPreferences, allowpopups), src/main/os-tools.mjs (how a tool is defined + its handler, so you know how to add a "render"/"inject" tool), preview/browser-host.mjs (server-mode CDP client).`

const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['approach', 'mechanism', 'canRenderArbitraryHtml', 'persistsAcrossNav', 'tripsBotRedirect', 'implementationCost', 'recommendation'],
  properties: {
    approach: { type: 'string' },
    mechanism: { type: 'string', description: 'exactly how it injects/renders custom UI, step by step' },
    codeChanges: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { file: { type: 'string' }, change: { type: 'string' } }, required: ['file', 'change'] } },
    canRenderArbitraryHtml: { type: 'boolean', description: 'can it render arbitrary agent-authored HTML/CSS/JS, not just hide/restyle existing elements?' },
    persistsAcrossNav: { type: 'boolean', description: 'does the render survive LinkedIn SPA route changes / reloads?' },
    tripsBotRedirect: { type: 'string', enum: ['no', 'maybe', 'yes'] },
    stealthRationale: { type: 'string', description: 'why it does or does not trip the redirect, grounded in the mechanism' },
    functionalBinding: { type: 'string', description: 'how (or whether) the rendered UI can DRIVE the real page (submit, post, navigate) so it stays functional' },
    implementationCost: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
    testPlan: { type: 'string', description: 'how to verify it renders AND does not trip the redirect, against the live LinkedIn surface' },
    risks: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string', description: 'your honest call: lead, hybrid-component, or avoid' },
  },
}

const APPROACHES = [
  { key: 'insertCSS', brief: 'Electron webContents.insertCSS for declutter + restyle (native CSS injection, no executeJavaScript at all). Cover: can it ALSO get arbitrary DOM/overlay HTML onto the page (it cannot add DOM by itself, so what is the minimal complementary mechanism), how it persists, and whether a pure-CSS path is invisible to the bot-detector.' },
  { key: 'preload', brief: 'Set a preload script on the web <webview> (webPreferences.preload / the <webview> preload attribute) that runs in an ISOLATED world before page JS, mounts our overlay root, and listens for render commands over IPC/postMessage. Cover the exact SurfaceFrame.tsx/index.ts/preload changes, isolated-world DOM access, persistence across nav, and why isolated-world rendering is the stealthiest in-page option.' },
  { key: 'addScriptOnNewDocument', brief: 'CDP Page.addScriptToEvaluateOnNewDocument (one attach) for document-start, nav-persistent injection of a self-contained render layer, instead of repeated executeJavaScript polling. Cover detach lifecycle vs the existing idle-detach, and whether one-attach is meaningfully stealthier than 350ms polling.' },
  { key: 'oneshot-pauseperception', brief: 'Minimal-code path: a SINGLE executeJavaScript that installs a self-running in-page render layer (a MutationObserver-driven overlay needing NO further outside calls), PLUS a way to PAUSE the 350ms perception DRAIN on this specific surface (the likely redirect trigger). Cover exactly where to add a per-surface "perception paused" flag and a "render bundle" tool in os-tools.mjs/osActions.ts/perception-core.mjs.' },
  { key: 'overlay-surface', brief: 'Do NOT inject into LinkedIn at all: render the custom UI in a SEPARATE BlitzOS srcdoc surface positioned exactly over (or beside) the web surface, fed by passively-captured data (screenshots + vision, or infrequent gentle reads). Cover alignment/overlap, how to make it feel in-place, refresh cadence that stays under the detector, and what functional binding is still possible (e.g. click-through, or driving via occasional CDP input).' },
  { key: 'stealth-harden', brief: 'Investigate and DEFEAT the detection itself. Use web search: what does LinkedIn / cs.ns1p.net key on (navigator.webdriver, CDP Runtime.enable / Runtime.consoleAPICalled, Page.frameNavigated, injected-eval timing, missing user-gesture)? Determine whether simply STOPPING the 350ms DRAIN poll is sufficient, or whether active injection is inherently detectable and must be masked. Return the concrete masking steps.' },
]

phase('Design')
const designs = (await parallel(APPROACHES.map((a) => () =>
  agent(`${GOAL}\n\nYOUR APPROACH = "${a.key}": ${a.brief}\n\nDesign THIS approach concretely and return the schema. Be specific: exact files + changes (cite file:line), whether it can render ARBITRARY html (not just restyle), whether it survives SPA nav, and a grounded judgment on whether it trips the bot-redirect and why. Do not hedge on tripsBotRedirect; commit to no/maybe/yes with rationale.`,
    { label: `design:${a.key}`, phase: 'Design', schema: DESIGN_SCHEMA })
))).filter(Boolean)

phase('Synthesize')
const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['primaryApproach', 'why', 'buildPlan', 'liveTestPlan'],
  properties: {
    primaryApproach: { type: 'string' },
    why: { type: 'string' },
    hybridWith: { type: 'array', items: { type: 'string' }, description: 'other approaches to combine in (e.g. pause-perception + preload + insertCSS)' },
    buildPlan: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['step', 'file', 'change'], properties: { step: { type: 'string' }, file: { type: 'string' }, change: { type: 'string' } } } },
    liveTestPlan: { type: 'string', description: 'serial steps to test against the running LinkedIn surface, including how to detect a redirect early and recover' },
    ranking: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['approach', 'score', 'note'], properties: { approach: { type: 'string' }, score: { type: 'number' }, note: { type: 'string' } } } },
  },
}
const synth = await agent(`You are the architect. Here are ${designs.length} grounded designs for rendering arbitrary custom UI inside a hostile LinkedIn web surface without tripping its anti-bot redirect:\n\n${JSON.stringify(designs, null, 1)}\n\nRank them by, in order: (1) will NOT trip the bot-redirect, (2) can render ARBITRARY html in-place (not just restyle), (3) persists across SPA nav, (4) low implementation cost in THIS codebase, (5) enables functional binding (driving the real page). Pick ONE primary approach or an explicit hybrid (e.g. "pause perception + preload render layer + insertCSS"). Return the schema with a concrete ORDERED build plan (exact files + changes for THIS codebase) and a serial live-test plan against the running LinkedIn surface that detects a redirect early. Be decisive.`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA })

phase('Stress')
const STRESS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['willItWork', 'topRisks'],
  properties: {
    willItWork: { type: 'string', enum: ['yes', 'risky', 'no'] },
    topRisks: { type: 'array', items: { type: 'string' } },
    fixes: { type: 'array', items: { type: 'string' } },
    blindSpots: { type: 'array', items: { type: 'string' } },
  },
}
const stress = (await parallel([1, 2].map((i) => () =>
  agent(`Be a ruthless skeptic. The architect recommends this plan to render arbitrary custom UI inside hostile LinkedIn without tripping its anti-bot:\n\n${JSON.stringify(synth, null, 1)}\n\nFind the strongest concrete reasons it FAILS: (a) will it STILL trip the redirect (LinkedIn detection is aggressive)? (b) will the render actually persist + show across SPA re-renders and nav? (c) hidden integration problems in THIS codebase (read the files to check)? (d) does it truly let us render ARBITRARY UI, or secretly only restyle? For each risk give a concrete fix. Lens ${i}: ${i === 1 ? 'focus on the anti-bot / stealth failure modes' : 'focus on the codebase-integration + persistence failure modes'}. Return the schema.`,
    { label: `stress:${i}`, phase: 'Stress', schema: STRESS_SCHEMA })
))).filter(Boolean)

return { designs, recommendation: synth, stress }
