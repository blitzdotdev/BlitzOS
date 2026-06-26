// Generate doctrine-review.md — ONE annotatable file with every prompt-surface injected into a BlitzOS
// agent. For each surface: a purpose TLDR, the VERBATIM text (rendered from the live module where it can be
// imported, sliced from source otherwise — never retyped), and a blank feedback block for the human reviewer.
//
// Usage:  node scripts/build-doctrine-review.mjs           (writes ./doctrine-review.md)
// Re-run after editing source to refresh the text. NOTE: re-running OVERWRITES the file, so copy out any
// feedback you've written before regenerating (or annotate fixes directly in source as you go).
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const rd = (rel) => readFileSync(join(ROOT, rel), 'utf8')

// ── verbatim helpers ────────────────────────────────────────────────────────────────────────────
// Fenced block whose fence is always longer than any backtick run inside, so embedded ``` survives.
function fence(content, lang = '') {
  let longest = 0
  for (const m of String(content).matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  const f = '`'.repeat(Math.max(3, longest + 1))
  return `${f}${lang}\n${String(content).replace(/\n+$/, '')}\n${f}`
}
function dedent(lines) {
  const nonEmpty = lines.filter((l) => l.trim())
  const min = nonEmpty.reduce((m, l) => Math.min(m, l.match(/^\s*/)[0].length), Infinity)
  return lines.map((l) => l.slice(Number.isFinite(min) ? min : 0)).join('\n')
}
// Raw source slice: from the first line matching `anchor`, keep following lines while the running line ends
// with `=` or `+` (declaration / string concatenation). Covers single-line consts AND multi-line concat.
function sliceConst(rel, anchor) {
  const lines = rd(rel).split('\n')
  const start = lines.findIndex((l) => anchor.test(l))
  if (start < 0) return `[NOT FOUND: ${anchor} in ${rel}]`
  const out = [lines[start]]
  let i = start
  while (/[=+]\s*$/.test(lines[i].trim())) out.push(lines[++i])
  return dedent(out)
}
function sliceLine(rel, anchor) {
  const line = rd(rel).split('\n').find((l) => anchor.test(l))
  return line ? line.trim() : `[NOT FOUND: ${anchor} in ${rel}]`
}

// ── live-rendered surfaces (imported, so the text == exactly what the agent receives) ─────────────
const ar = await import(join(ROOT, 'src/main/agent-runtime.mjs'))
const pc = await import(join(ROOT, 'src/main/perception-core.mjs'))
const ag = await import(join(ROOT, 'src/main/blitzscript/agent.mjs'))
const ct = await import(join(ROOT, 'src/main/chat-titleer.mjs'))
const ot = await import(join(ROOT, 'src/main/os-tools.mjs'))
let agentTypeBlocks = '[import failed]'
try {
  const h = await import(join(ROOT, 'src/main/blitzscript/harnesses.mjs'))
  agentTypeBlocks = Object.entries(h.AGENT_TYPE_BLOCKS).map(([k, v]) => `${k}:\n  ${v || '(no extra system block — the default agent)'}`).join('\n\n')
} catch (e) { agentTypeBlocks = `[import failed: ${e.message}]` }

const SAMPLE_URL = 'https://relay.agentsocket.dev/x/abcd'
const bootstrapPrimary = ar.buildBootstrap(SAMPLE_URL, '0', null, 'workspace')
const bootstrapPeer = ar.buildBootstrap(SAMPLE_URL, '7', null, 'workspace')
const noopOps = new Proxy({}, { get: () => async () => ({}) })
const tools = ot.makeOsTools(noopOps)
const toolList = (Array.isArray(tools) ? tools : [])
  .map((t) => `#### \`${t.path || t.name}\`\n\n${t.description || '(no description)'}`).join('\n\n')

// ── the surface table ─────────────────────────────────────────────────────────────────────────────
// tier 1 = always-on into the live Blitz agent | 1b = docs it reads on demand | 2 = workflow leaves | 3 = helper LLMs
const SECTIONS = [
  { tier: 1, title: 'Bootstrap prompt — primary agent (Blitz, "0")', src: 'src/main/agent-runtime.mjs › buildBootstrap()',
    purpose: 'The very first prompt the primary agent boots with (written to bootstrap.txt on every launch). Sets identity, how to reach the local HTTP API, an instruction to read the full manual, the hard web + visible-progress rules, how to recover its chat after a restart, and the background wait.sh event loop. Everything else layers on top of this.',
    body: fence(bootstrapPrimary, 'text') },

  { tier: 1, title: 'Bootstrap prompt — peer agent (spawned)', src: 'src/main/agent-runtime.mjs › buildBootstrap()',
    purpose: 'Same bootstrap for a non-primary peer agent (the pen button / spawn_agent). Differs only in identity ("a Blitz agent", never a number) and scope (it must tag its own agent id on every /events, /say, open_terminal call so threads never cross).',
    body: fence(bootstrapPeer, 'text') },

  { tier: 1, title: 'Boot-task duty — the resident (agent 0)', src: 'src/main/onboarding.ts › BLITZ_DUTY',
    purpose: 'The single duty doc agent "0" boots with. There is NO onboarding interview: it stays silent through the first-run wizard, then once the scan\'s context.md exists it is simply the resident (uses context.md, acts on requests, no cards / questions / greeting), under the act-vs-ask boundary.',
    body: fence(sliceConst('src/main/onboarding.ts', /const BLITZ_DUTY\b/), 'js') },

  { tier: 1, title: 'Boot-task duty — orchestrator', src: 'src/main/agent-runtime.mjs › orchestratorBootTask()',
    purpose: 'The standing duty for any agent with the orchestrators toggle ON. Licenses it to author and run blitzscript workflows for hard / large / massively parallel / adversarial tasks, with the strict rule to run them via the run_workflow syscall (not the raw runner or its own Workflow tool).',
    body: fence(ar.orchestratorBootTask(), 'text') },

  { tier: 1, title: 'Per-wake reminder (every /events response)', src: 'src/main/perception-core.mjs › EVENTS_REMINDER',
    purpose: 'A one-line standing nudge BlitzOS attaches to EVERY /events response (the `n` field) — the agent reads it on every wake. Re-grounds it: respond in the island chat, there is no canvas.',
    body: fence(pc.EVENTS_REMINDER, 'text') },

  { tier: 1, title: 'The operating manual — blitzos-agents.md', src: 'src/main/blitzos-agents.md (served at $BASE/agents.md)',
    purpose: 'The full manual every agent fetches on connect. The single source of truth for identity, tools, connections, web research, terminals, peer agents, workflows, the autonomy loop, and the human-facing prose style. This is the biggest and most important surface.',
    body: fence(rd('src/main/blitzos-agents.md'), 'markdown') },

  { tier: 1, title: 'The tool registry (syscall descriptions)', src: 'src/main/os-tools.mjs › makeOsTools()',
    purpose: 'Every syscall the agent can call. Each tool DESCRIPTION is doctrine: it is how the agent decides when and how to use that tool. Listed below is the LIVE registry (enumerated from makeOsTools), so it is exactly what ships. Note: each live connection ALSO injects dynamic tools (saved per-source tools from tools.json + discovered MCP tools) whose descriptions are author/MCP-provided and are not reviewable here.',
    body: toolList },

  { tier: 1, title: 'Orchestrator-enabled wake message', src: 'src/main/osActions.ts (set_orchestrators handler)',
    purpose: 'The message injected into an agent the instant the orchestrators toggle is switched ON. A quick how-to so it can start authoring workflows immediately, before it reads the full orchestrator.md.',
    body: fence(sliceLine('src/main/osActions.ts', /Orchestrators ENABLED:/), 'js') },

  { tier: '1b', title: 'Orchestrator how-to — blitzos-orchestrator.md', src: 'src/main/blitzos-orchestrator.md (copied to .blitzos/orchestrator.md)',
    purpose: 'The full workflow how-to an orchestrator agent reads on demand. When to write a workflow vs answer inline, the injected globals (agent/parallel/pipeline/phase/log), how to run via run_workflow, and the guardrails.',
    body: fence(rd('src/main/blitzos-orchestrator.md'), 'markdown') },

  { tier: '1b', title: 'Capabilities scaffold — blitz capabilities', src: 'src/main/blitzscript/capabilities.mjs',
    purpose: 'The orchestrator runs `bash .blitzos/blitz capabilities` before authoring a workflow to learn which harnesses / models / effort levels exist on this machine. The output is assembled at runtime by probing the machine; below is the static doctrine line it always includes.',
    body: fence(sliceLine('src/main/blitzscript/capabilities.mjs', /Author llm\(prompt/), 'js') },

  { tier: 2, title: 'Workflow leaf metadata block', src: 'src/main/blitzscript/agent.mjs › leafMetadata()',
    purpose: 'Appended to EVERY blitzscript workflow leaf-agent prompt. Tells the leaf its recursion depth, to NOT recurse (no nested workflows / sub-agents), and the act-vs-ask boundary.',
    body: fence(ag.leafMetadata(2), 'text') },

  { tier: 2, title: 'Workflow schema response wrapper', src: 'src/main/blitzscript/agent.mjs › SUMMARY_WRAP_NOTE',
    purpose: 'Appended to a SCHEMA workflow leaf\'s prompt, forcing a { meta.human_summary, output } response so the run can show a one-line human headline per step alongside the structured result.',
    body: fence(sliceConst('src/main/blitzscript/agent.mjs', /const SUMMARY_WRAP_NOTE\b/), 'js') },

  { tier: 2, title: 'Workflow agentType system blocks', src: 'src/main/blitzscript/harnesses.mjs › AGENT_TYPE_BLOCKS',
    purpose: 'System blocks injected (via --append-system-prompt) for a leaf\'s agentType. E.g. an Explore leaf is told to stay strictly read-only. An unknown type adds nothing.',
    body: fence(agentTypeBlocks, 'text') },

  { tier: 2, title: 'Workflow structured-output coax note', src: 'src/main/blitzscript/harnesses.mjs (buildStructured)',
    purpose: 'Appended to a leaf prompt when the harness lacks native JSON-schema support — a plain "JSON only, no prose" instruction so agent() can still parse and validate the result.',
    body: fence(sliceLine('src/main/blitzscript/harnesses.mjs', /Respond with ONLY a JSON value matching/), 'js') },

  { tier: 3, title: 'Narrator (Haiku) — milestone titles', src: 'src/main/agent-narrator.mjs › SYS + per-tick prompt',
    purpose: 'A helper Haiku call (not the agent itself) that turns an agent\'s raw tool rows into one short "now-playing" milestone line shown in chat. SYS = the rules; the per-tick prompt wraps SYS with the latest actions.',
    body: fence(sliceConst('src/main/agent-narrator.mjs', /const SYS\b/), 'js') + '\n\nPer-tick wrapper:\n' + fence(sliceLine('src/main/agent-narrator.mjs', /const prompt = `\$\{SYS\}/), 'js') },

  { tier: 3, title: 'Chat titler (Haiku) — auto-name a chat', src: 'src/main/chat-titleer.mjs › buildAgentTitlePrompt()',
    purpose: 'A helper Haiku call that auto-names a new agent chat from its first message.',
    body: fence(ct.buildAgentTitlePrompt("<the user's first message goes here>"), 'text') },
]

// ── emit ────────────────────────────────────────────────────────────────────────────────────────
const tierName = { 1: 'Tier 1 — always injected into the live Blitz agent', '1b': 'Tier 1b — docs the agent reads on demand', 2: 'Tier 2 — injected into workflow leaf agents', 3: 'Tier 3 — internal helper LLMs (Haiku)' }
let md = ''
md += '# BlitzOS doctrine review\n\n'
md += 'Every prompt-surface injected into a BlitzOS agent, in one place, for a pre-publish read-through. For each surface: a purpose TLDR, the **verbatim** text (rendered live from the module where importable, sliced from source otherwise — none of it is retyped), and a feedback block.\n\n'
md += '**How to use this.** Read top to bottom. When you spot an error, an outdated claim, an em dash, or anything to tighten, fix it in the SOURCE FILE listed under each surface (that is what ships), and jot a bullet in that surface\'s feedback block so we can track it. Regenerate with `node scripts/build-doctrine-review.mjs` (this OVERWRITES the file, so copy your feedback out first).\n\n'
md += `Generated from the working tree. ${SECTIONS.length} surfaces + the live tool registry (${(Array.isArray(tools) ? tools.length : 0)} tools).\n\n`

md += '## Global notes\n\n'
md += 'Cross-cutting issues that touch many surfaces (prose style, recurring claims, tone):\n\n'
md += '<!-- e.g. "em dashes appear in EVENTS_REMINDER and leafMetadata — agent-facing but still our style rule" -->\n- \n- \n\n'

md += '## Contents\n\n'
let lastTier = null
for (const [i, s] of SECTIONS.entries()) {
  if (s.tier !== lastTier) { md += `\n**${tierName[s.tier]}**\n\n`; lastTier = s.tier }
  md += `${i + 1}. ${s.title}\n`
}
md += '\n---\n\n'

lastTier = null
for (const [i, s] of SECTIONS.entries()) {
  if (s.tier !== lastTier) { md += `## ${tierName[s.tier]}\n\n`; lastTier = s.tier }
  md += `### ${i + 1}. ${s.title}\n\n`
  md += `**Source:** \`${s.src}\`\n\n`
  md += `**Purpose:** ${s.purpose}\n\n`
  md += `${s.body}\n\n`
  md += `#### ✏️ Feedback\n<!-- bullets; quote the exact line you mean -->\n- \n\n`
  md += '---\n\n'
}

md += '## Out of scope / deferred\n\n'
md += '- **Connection dynamic tools** — each live connection injects tools from its per-source `tools.json` + discovered MCP tools; their descriptions are author/MCP-provided, not BlitzOS doctrine, so they are not reviewed here.\n'
md += '- **`context.md`** — the onboarding scan primer is generated per machine (pure scan data, no injected prompt), so there is no static doctrine text to review.\n'
md += '- **`preview/backend.mjs` widget-authoring.md** — server-mode + widgets are deferred in V1, so that surface is dormant for the island.\n'
md += '- **`chat.md`** — an agent tailing its own transcript on restart is conversation history re-entering context, not doctrine.\n'

writeFileSync(join(ROOT, 'doctrine-review.md'), md)
console.log(`wrote doctrine-review.md — ${md.length} bytes, ${SECTIONS.length} surfaces, ${(Array.isArray(tools) ? tools.length : 0)} tools`)
