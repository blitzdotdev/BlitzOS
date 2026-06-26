export const meta = {
  name: 'blitzos-features-3-5-exploration',
  description: 'Explore implementation approaches for BlitzOS feature 3 (append-only logging for training + RAG) and feature 5 (idle daydreaming -> unrequested helpful work), grounded in the real code',
  phases: [
    { title: 'Ground', detail: 'verify the real current seams in code, not the aspirational plans/ docs' },
    { title: 'Explore', detail: '4 grounded approaches per feature, distinct angles' },
    { title: 'Critique', detail: '2-lens adversarial panel per approach' },
    { title: 'Synthesize', detail: 'recommended design per feature + how 3 and 5 compose' }
  ]
}

const REPO = '/Users/minjunes/superapp/teenybase/agent-os'

// ---------- schemas ----------
const GROUNDING_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'seams', 'findings', 'docVsCode', 'gaps'],
  properties: {
    area: { type: 'string' },
    seams: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'path', 'whatItDoes', 'reuseFor'],
      properties: { name: { type: 'string' }, path: { type: 'string' }, whatItDoes: { type: 'string' }, reuseFor: { type: 'string' } } } },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['claim', 'evidence', 'confidence'],
      properties: { claim: { type: 'string' }, evidence: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } } } },
    docVsCode: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } }
  }
}
const APPROACH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'feature', 'oneLiner', 'coreIdea', 'architecture', 'reusedSeams', 'netNew', 'keyDesignChoice', 'dataOrControlFlow', 'pros', 'cons', 'risks', 'pureSubstrateSplit', 'effort', 'openForks'],
  properties: {
    name: { type: 'string' }, feature: { type: 'string', enum: ['3', '5'] }, oneLiner: { type: 'string' }, coreIdea: { type: 'string' },
    architecture: { type: 'array', items: { type: 'string' } },
    reusedSeams: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['seam', 'how'], properties: { seam: { type: 'string' }, how: { type: 'string' } } } },
    netNew: { type: 'array', items: { type: 'string' } },
    keyDesignChoice: { type: 'string' }, dataOrControlFlow: { type: 'string' },
    pros: { type: 'array', items: { type: 'string' } }, cons: { type: 'array', items: { type: 'string' } }, risks: { type: 'array', items: { type: 'string' } },
    pureSubstrateSplit: { type: 'object', additionalProperties: false, required: ['blitzosMechanism', 'agentPolicy'],
      properties: { blitzosMechanism: { type: 'array', items: { type: 'string' } }, agentPolicy: { type: 'array', items: { type: 'string' } } } },
    effort: { type: 'string', enum: ['low', 'medium', 'high'] }, openForks: { type: 'array', items: { type: 'string' } }
  }
}
const CRITIQUE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['approachName', 'lens', 'verdict', 'killShots', 'fixes', 'score', 'mustAddress'],
  properties: {
    approachName: { type: 'string' }, lens: { type: 'string' },
    verdict: { type: 'string', enum: ['strong', 'viable', 'flawed', 'violates-directive'] },
    killShots: { type: 'array', items: { type: 'string' } }, fixes: { type: 'array', items: { type: 'string' } },
    score: { type: 'number' }, mustAddress: { type: 'string' }
  }
}
const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['feature', 'recommendedDesign', 'spine', 'graftedFrom', 'rejected', 'concreteSeams', 'schemaOrMechanism', 'phasing', 'openDecisionsForUser'],
  properties: {
    feature: { type: 'string' }, recommendedDesign: { type: 'string' }, spine: { type: 'string' },
    graftedFrom: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'string' } },
    concreteSeams: { type: 'array', items: { type: 'string' } }, schemaOrMechanism: { type: 'string' },
    phasing: { type: 'array', items: { type: 'string' } }, openDecisionsForUser: { type: 'array', items: { type: 'string' } }
  }
}
const COMPOSITION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['theFlywheel', 'sharedStore', 'sharedSchedulingSeam', 'sharedPrivacyPosture', 'costInterplay', 'buildFirst', 'risks'],
  properties: {
    theFlywheel: { type: 'string' }, sharedStore: { type: 'string' }, sharedSchedulingSeam: { type: 'string' },
    sharedPrivacyPosture: { type: 'string' }, costInterplay: { type: 'string' }, buildFirst: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } }
  }
}

// ---------- prompt builders ----------
const CONSTRAINTS = [
  '## Hard BlitzOS constraints (a design that violates these is wrong)',
  '- PURE SUBSTRATE (locked decision #6): BlitzOS ships NO policy/decision/judgment code. The connected agent (Claude over agent-socket, or a `claude -p` runner) decides WHAT to log, WHAT to retrieve, WHAT to daydream/do. BlitzOS may add ONLY dumb mechanism — storage/append/read verbs, a content-agnostic idle TICK, transports. State precisely which parts are BlitzOS mechanism vs agent policy.',
  '- Outward writes into a logged-in account ALWAYS require a per-action human confirm; a STOP kill-switch suspends autonomy. Daydreamed work must respect this (no silent outward writes).',
  '- Local-first/privacy: the relay redacts un-shared surface content (redactMoment + content-share consent); the localhost-trusted brain is the natural home for full reads. Logging + daydreaming touch sensitive third-party content — address egress explicitly.',
  '- Reuse REAL seams from the grounding; cite actual files/symbols. Do NOT invent seams the grounding says do not exist.'
].join('\n')

function groundPrompt(t) {
  return [
    `You are grounding a BlitzOS design exploration. Establish the VERIFIED CURRENT STATE of one area of the codebase. TRUST THE CODE over any plans/*.md doc — several docs are aspirational and reference files that may not exist. Repo root: ${REPO}`,
    `## Area: ${t.area}`,
    `## Read these (Read + Grep as needed): ${t.files}`,
    `## Answer concretely: ${t.q}`,
    'For each seam give the real path + what it does + how it could be reused for feature 3 (append-only logging for training + RAG) or feature 5 (idle daydreaming). In docVsCode, flag every place a plans/ doc claims something the code does NOT have. Cite file:line or symbol as evidence. Be concise and high-signal. Return via StructuredOutput.'
  ].join('\n')
}

function featureBlurb(f) {
  return f === '3'
    ? 'FEATURE 3 — Append-only interaction/correction logging with TWO payoffs: (1) a TRAINING corpus to later fine-tune / dynamic-eval a personalized "guardian angel" model on this one principal; (2) RETRIEVAL-AUGMENTATION (RAG): at runtime the agent retrieves relevant past interactions/corrections/preferences and injects them into context so it acts more like the principal. Capture signals already flowing in BlitzOS (Cmd+Z layout reverts, write-confirm rejections, content-share 👁 toggles, chat corrections, accepted/rejected agent actions) plus statements/Q&A. This is the "preference flywheel / memory consolidator" = the product moat.'
    : 'FEATURE 5 — Idle "daydreaming": when the principal is AWAY (possibly hours, possibly laptop closed), the agent does USEFUL WORK THEY NEVER ASKED FOR, and they return to DISCOVER it (e.g. reprocesses the log for serendipitous connections, drafts, researches, organizes, pre-computes the next best question). Must feel helpful — not creepy, noisy, or automation-fatigue; must be reversible/dismissable; must NOT silently perform outward writes into logged-in accounts. "If it is idle, something has gone wrong" — but cost is real.'
}

function genPrompt(spec, brief) {
  return [
    'You are a BlitzOS systems architect. Design ONE concrete, code-grounded implementation approach for the following feature, committed to a SPECIFIC angle (do not converge to a generic design).',
    '## The feature', featureBlurb(spec.feature),
    '## YOUR ANGLE — design THIS thesis to its strongest form', spec.name, `Seed: ${spec.seed}`,
    CONSTRAINTS,
    '## GROUNDING — verified current state of the codebase (trust this over any plans/*.md)', brief,
    'Produce the approach via StructuredOutput. Be concrete: name the files you would add/change, the data shapes, the exact flow, and the open forks. pureSubstrateSplit must honestly separate BlitzOS dumb-mechanism from agent policy.'
  ].join('\n')
}

function critPrompt(approach, spec, brief, lens) {
  const lensText = lens === 'substrate-feasibility'
    ? 'LENS A — Substrate-purity & feasibility. Does it keep ALL policy in the agent and only dumb mechanism in BlitzOS (decision #6)? Does it reuse the REAL seams (per grounding) or hallucinate non-existent ones? Is it actually buildable on the current code? Will it drift/duplicate across the Electron + server transports (the os-tools.ts / shared-.mjs-kernel pattern)? Flag any judgment logic smuggled into BlitzOS code.'
    : 'LENS B — Cost, privacy, trust, vision-fit. Cost blowup (model-in-a-loop, embeddings, idle wakeups). Privacy/egress (logging sensitive third-party content; daydreaming reading it; what leaves the device vs the localhost brain). TRUST: is unrequested work actually helpful or noise/creepy/automation-fatigue? Reversible? For F3: does the corpus train a useful model AND does RAG retrieve the RIGHT things, or is it junk? Does it deliver the FELT vision or quietly water it down?'
  return [
    'You are an ADVERSARIAL reviewer of a BlitzOS design. Try to REFUTE or break it; default to skepticism. Only call it strong if it survives.',
    `## Feature ${spec.feature} approach under review: ${approach.name}`, JSON.stringify(approach),
    `## ${lensText}`,
    '## Grounding (real codebase state)', brief,
    'Return via StructuredOutput: concrete kill-shots (failure modes), fixes, a score /10 on THIS lens, and the single thing it MUST address.'
  ].join('\n')
}

function synthPrompt(feature, evaluated, brief) {
  const cover = feature === '3'
    ? 'Your design must cover: what is captured + by whom (agent vs dumb emitter), the storage tier(s) + why, the schema/taxonomy, how RETRIEVAL works at runtime (how past context is injected into the agent loop), how the TRAINING corpus is produced/exported, any annotation/PRINCIPAL.md compression, and privacy/egress.'
    : 'Your design must cover: idle detection (BlitzOS mechanism) vs daydream policy (the agent), WHAT work is safe to auto-do vs must wait for approval, the COST firewall, how work is PRESENTED non-intrusively (the "while you were away" surface), reversibility/trust, and whether/how it runs server-side (laptop closed).'
  return [
    `You are the lead BlitzOS architect. ${evaluated.length} independent approaches for FEATURE ${feature} were generated and each adversarially critiqued on two lenses. Synthesize a RECOMMENDED design.`,
    'Do NOT just pick one — choose the strongest SPINE, GRAFT the best ideas from runners-up, and DISCARD what the critiques killed. Respect: pure-substrate (#6), outward-write-confirm + STOP, local-first privacy, and the real seams.',
    featureBlurb(feature), cover,
    `## The ${evaluated.length} approaches + their critiques`, JSON.stringify(evaluated),
    '## Grounding', brief,
    'Return via StructuredOutput: the recommended design (prose), the spine + why, what you grafted from which runner-up, what you rejected, the concrete real seams to touch, the concrete schema (F3) or idle mechanism (F5), a phasing (cheapest-highest-leverage first), and the open decisions that need the USER.'
  ].join('\n')
}

function compositionPrompt(evaluated, brief) {
  return [
    'You are the lead BlitzOS architect. Features 3 (logging -> training + RAG) and 5 (idle daydreaming) must COMPOSE into one flywheel, not be two bolt-ons. Design the shared substrate.',
    'Articulate the loop: daydreaming (5) consumes the log (3) -> produces unrequested work -> the user reaction on return (accept/dismiss/edit) is itself a correction logged by (3) -> which improves both retrieval and the next daydream.',
    'Cover: the shared store + schema, the shared idle/scheduling seam, the shared privacy posture, the cost interplay (daydreaming is the biggest log consumer AND cost center), and the ONE piece of substrate to build FIRST that both features ride.',
    '## All approaches + critiques (both features)', JSON.stringify(evaluated),
    '## Grounding', brief,
    'Return via StructuredOutput.'
  ].join('\n')
}

// ---------- phase 1: ground ----------
log('Grounding: verifying the real seams in code (journal.mjs, correction signals, idle/heartbeat, presentation, cloud RAG)')
const groundingTasks = [
  { area: 'memory / log / persistence store', files: `${REPO}/src/main/workspace.mjs, ${REPO}/src/main/workspace-host.mjs, ${REPO}/src/main/blitzos-agents.md (Memory + authoring sections); grep ${REPO}/src/main and ${REPO}/src for "journal"`,
    q: 'What is the ACTUAL current durable-memory mechanism (workspace notes as files? chat.md? .blitzos/state/*?)? Does src/main/journal.mjs or a journal/ dir EXIST, or is it only in the GA doc? What append-only structures exist (e.g. appendChatMessage)? What atomic-write/path-jail/self-write-suppress/watch machinery in workspace.mjs could a new append-only interaction log reuse?' },
  { area: 'correction / veto signals + consent/act loop', files: `${REPO}/src/renderer/src/store.ts (layoutHistory/undoLayout), ${REPO}/src/renderer/src/App.tsx (Cmd+Z, content-share toggle, provider-approval card), ${REPO}/src/main/perception-core.mjs (setContentShare, emitUserMessage, emitSurfaceAction), ${REPO}/src/main/provider-bridge.ts, ${REPO}/src/main/approval-queue.mjs`,
    q: 'Exactly which user-veto/correction signals flow today and WHERE (layout undo, content-share 👁, chat trigger:message, provider write approve/deny, srcdoc action callbacks)? Which are observable in main (Node) vs only in the renderer? Does a write-confirm gate for surface_control writes exist yet, or only for provider_call writes? For each signal, where is the tap point to emit a structured "correction" log entry?' },
  { area: 'moment stream / idle / agent-runner brain loop', files: `${REPO}/src/main/perception-core.mjs (BATCH_MS, USER_TYPES, hasUser, flush, waitForEvents, the setInterval batch timer), ${REPO}/src/main/events.ts, ${REPO}/src/main/agent-runner.mjs, ${REPO}/src/main/os-tools.ts (/events, /say)`,
    q: 'How is the agent woken? Confirm whether moments fire ONLY on user activity (hasUser gate) so with NO user the brain blocks on /events indefinitely. Is there ANY idle/heartbeat today? Where EXACTLY would a dumb idle-tick go to emit a low-priority wake moment when quiet? How does agent-runner supervise the claude -p brain and could it keep running while the user is away/disconnected? Summarize the /events contract the agent sees.' },
  { area: 'surface presentation + agent authoring (daydream output)', files: `${REPO}/src/main/blitzos-agents.md (authoring, surface kinds, workspaces, say, design language), ${REPO}/src/main/osActions.ts (osSay, osCreateSurface, workspace tools), ${REPO}/src/main/workspace-host.mjs (appendChat, performSwitch, list/create), ${REPO}/src/renderer/src/App.tsx (activity panel)`,
    q: 'How does the agent present work today (write a file into the workspace folder -> surface in ~250ms; srcdoc panels; notes; the say chat; the pinned activity panel; separate folder-backed workspaces)? What is the BEST existing seam for a NON-INTERRUPTING "while you were away" digest? Can the agent create + populate a SEPARATE workspace for daydreamed work without disturbing the active desktop? How do chat.md / activity persist?' },
  { area: 'cloud storage + retrieval substrate (training corpus + RAG)', files: `${REPO}/src/main/os-tools.ts (new_app / blitz.dev provisioning + its description), ${REPO}/CLAUDE.md; plus your knowledge of Cloudflare (D1, R2, Vectorize, Workers AI embeddings like bge) and teenybase`,
    q: 'What storage/retrieval substrate is reachable for (a) a training corpus and (b) runtime RAG? What does blitz.dev/teenybase actually provide (D1 + R2 + one-call provision via new_app)? Are Cloudflare Vectorize + Workers AI embeddings the natural RAG primitives, and how would BlitzOS reach them (a provisioned blitz.dev app? direct binding?)? Contrast the local-only retrieval option (grep/keyword/recency over an fs log) vs the cloud-embeddings option. Flag clearly what is NOT in the repo today.' }
]
const grounding = (await parallel(groundingTasks.map((t) => () =>
  agent(groundPrompt(t), { label: `ground:${t.area.split(' ')[0]}`, phase: 'Ground', schema: GROUNDING_SCHEMA, agentType: 'Explore' })
))).filter(Boolean)
const brief = JSON.stringify(grounding)
log(`Grounding complete (${grounding.length}/5). Exploring 8 approaches with adversarial critique...`)

// ---------- phase 2+3: explore -> critique (pipeline) ----------
const SPECS = [
  { feature: '3', angle: 'A', name: 'FS-first append-only journal (local, grep/recency retrieval, no embeddings)',
    seed: 'An append-only log living in the workspace folder / .blitzos, matching "the filesystem IS the canvas, notes are files". JSONL or md appended via the existing workspace.mjs atomic/jailed write machinery. Training corpus = the raw file. Retrieval = grep + recency + the agent reading it; NO embeddings. BlitzOS provides thin append/read/grep verbs; the agent owns taxonomy + when to recall. Most local, cheapest, privacy-trivial. Push on: how far keyword/recency RAG gets before you truly need embeddings, and the self-write-suppression so the log does not trigger reconcile.' },
  { feature: '3', angle: 'B', name: 'Cloudflare event log + Vectorize embeddings RAG (the cloud/scale tier)',
    seed: 'Events -> a blitz.dev/teenybase app (D1 rows + R2 blobs) provisioned via new_app, embedded into Cloudflare Vectorize via Workers AI (bge). Runtime RAG = semantic kNN over Vectorize injected into the agent per-moment context. Training corpus = D1/R2 export. Powerful + scalable but egress-heavy. Confront: what leaves the device, embedding cost, sync, and how this stays OFF by default behind the local-first posture.' },
  { feature: '3', angle: 'C', name: 'Agent-owned memory via thin generic tools (log_event / recall)',
    seed: 'BlitzOS exposes ONLY thin generic tools (log_event{type,payload,refs}, recall{query,k,filters}) added once to the shared os-tools.ts registry so both transports get them. The agent owns the entire taxonomy, what to log, and when to retrieve. The store backend is pluggable (fs now, D1/Vectorize later) behind the tool. Focus on the tool CONTRACT, how the agent is prompted (blitzos-agents.md) to log+recall in the /events loop, and the dual training-export vs RAG-read paths through one tool surface.' },
  { feature: '3', angle: 'D', name: 'Tiered Gwern flywheel: raw log (training) + augmentation -> PRINCIPAL.md + dual retrieval',
    seed: 'The full Gwern design: raw append-only log (training) -> a periodic AUGMENTATION/annotation pass ("what this item meant") -> a compressed PRINCIPAL.md (the live model of the principal, value-of-item measured by how much it changes PRINCIPAL.md) -> retrieval pulls from BOTH the always-in-context PRINCIPAL.md AND the indexed log on-demand. Hot local + cold indexed. Show the compression metric and how training corpus, RAG, and PRINCIPAL.md are three views of one store.' },
  { feature: '5', angle: 'A', name: 'Dumb idle heartbeat + agent-policy daydream -> while-you-were-away surface',
    seed: 'Add ONE dumb idle-tick to perception-core (a low-priority heartbeat moment after N min quiet) as the ONLY new BlitzOS mechanism. ALL daydream logic is agent policy (reprocess log, draft, research, organize), constrained to no-outward-write. Output parked in a NON-INTERRUPTING "while you were away" surface (a note/srcdoc written into the workspace, or a dedicated workspace). Maximize purity, minimize BlitzOS code. Define the tick contract, how the agent self-limits cost, and how the tick is content-agnostic (scheduling, not policy).' },
  { feature: '5', angle: 'B', name: 'Daydream -> candidate work items -> safe auto-exec + review queue',
    seed: 'Daydream produces a QUEUE of candidate work items; the agent auto-executes only the SAFE, reversible subset (build surfaces, drafts, research, file organization, no outward writes); anything outward-write/irreversible stays a PROPOSAL the user approves on return. Output = a structured review-queue surface (accept/dismiss/edit each). Focus on the safe/unsafe taxonomy, the approval UX, reversibility, and how this rides the existing write-confirm + Cmd+Z reversibility seams.' },
  { feature: '5', angle: 'C', name: 'Server-side always-on daydreaming (idle = disconnected; rides the cloud track)',
    seed: 'Reframe idle = principal DISCONNECTED (laptop closed), not just not-typing. Daydreaming is most valuable running server-side while the user is away (rides the always-on/server-mode track). The server brain daydreams continuously within a budget; the user reopens to find work synced into their workspace. Address the tie to server-mode + persistent profile + the agent-runner supervisor, the hard cost ceiling for unbounded idle, and trust when work happened entirely unattended.' },
  { feature: '5', angle: 'D', name: 'Scheduled reprocessing pipeline over the feature-3 log (the log-consuming design)',
    seed: 'The daydream IS a scheduled pipeline over the feature-3 log: recombine random log items (anti-spaced-repetition serendipity) -> mine connections -> run the augmentation pass -> pre-compute the next-best elicitation question -> emit 1-3 concrete artifacts. Explicitly the feature-3-consuming design; bounded by a hard artifact cap + token budget. Show the pipeline stages, how it makes the log pay off, and the "for when you are free" digest.' }
]

const evaluated = (await pipeline(
  SPECS,
  (spec) => agent(genPrompt(spec, brief), { label: `approach:${spec.feature}${spec.angle}`, phase: 'Explore', schema: APPROACH_SCHEMA }),
  (approach, spec) => {
    if (!approach) return null
    return parallel([
      () => agent(critPrompt(approach, spec, brief, 'substrate-feasibility'), { label: `crit:${spec.feature}${spec.angle}:sub`, phase: 'Critique', schema: CRITIQUE_SCHEMA }),
      () => agent(critPrompt(approach, spec, brief, 'cost-privacy-trust'), { label: `crit:${spec.feature}${spec.angle}:cpt`, phase: 'Critique', schema: CRITIQUE_SCHEMA })
    ]).then((crits) => ({ feature: spec.feature, angle: spec.angle, approach, critiques: crits.filter(Boolean) }))
  }
)).filter(Boolean)

const f3 = evaluated.filter((e) => e.feature === '3')
const f5 = evaluated.filter((e) => e.feature === '5')
log(`Explored + critiqued ${evaluated.length} approaches (F3=${f3.length}, F5=${f5.length}). Synthesizing...`)

// ---------- phase 4: synthesize ----------
const [synthesis3, synthesis5, composition] = await parallel([
  () => agent(synthPrompt('3', f3, brief), { label: 'synth:feature3', phase: 'Synthesize', schema: SYNTH_SCHEMA }),
  () => agent(synthPrompt('5', f5, brief), { label: 'synth:feature5', phase: 'Synthesize', schema: SYNTH_SCHEMA }),
  () => agent(compositionPrompt(evaluated, brief), { label: 'synth:composition', phase: 'Synthesize', schema: COMPOSITION_SCHEMA })
])

return {
  grounding,
  approaches: evaluated,
  synthesis: { feature3: synthesis3, feature5: synthesis5, composition }
}