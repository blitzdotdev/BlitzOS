export const meta = {
  name: 'serve-kimi-k2.6-fast',
  description: 'Research how to serve an open-source Kimi-K2.6-class MoE at real-time decode speed: the engineering constraint, the gap from optimal, and the single bottleneck to solve',
  phases: [
    { title: 'Research', detail: 'parallel: decode physics, hardware, serving stack, speculative decoding, gap+bottleneck, practical path' },
    { title: 'Synthesize', detail: 'the bottleneck, the gap from optimal, the recommended path — quantitative' },
    { title: 'Stress', detail: 'adversarial inference engineers attack the numbers + the path' },
  ],
}

const GOAL = `RESEARCH GOAL: determine how to serve an open-source "Kimi K2.6 class" model (a large, smart Mixture-of-Experts LLM — Moonshot's Kimi K2 is ~1 trillion total params with ~32B active per token; K2.6 is a newer revision) at REAL-TIME decode speed, and pinpoint THE bottleneck, with numbers.

WHY: we are building a generative OS where the UI is generated live by an LLM on every user interaction, so we need BOTH fast AND smart. Our measured reality today:
- Cerebras "gpt-oss-120b" (a ~120B MoE on wafer-scale hardware): ~1500 tokens/sec single-stream — fast enough for real-time, but not as smart as we want.
- Fireworks "kimi-k2p6-fast" (Kimi K2.6 on GPUs): ~238 tokens/sec — much smarter, but ~6x too slow for real-time interaction.
The question: can a Kimi-K2.6-class model be served at Cerebras-gpt-oss-class speed (roughly 800-1500+ tok/s, low-latency single-stream), and if not, exactly what stops it, how far off are we, and what is the one bottleneck to solve?

DELIVER, with NUMBERS: the engineering constraint, how far real systems are from the theoretical optimum, and the single bottleneck. Use web search for CURRENT (mid-2026) figures — Kimi K2.6 architecture, real achieved tok/s on vLLM/SGLang/TRT-LLM, hardware bandwidth/capacity/$/hr, who hosts it. If a figure isn't searchable, derive it from first principles and FLAG it for verification. Be quantitative — formulas and numbers, not vibes. Cite sources.`

const DIMS = [
  { key: 'decode-physics', brief: 'The fundamental decode-speed constraint. Derive single-stream tok/s for a large MoE from first principles: decode is MEMORY-BANDWIDTH-bound — each generated token reads the ACTIVE weights from memory, so tok/s ≈ memory_bandwidth / (active_params × bytes_per_param). Find Kimi K2.6 real architecture (total params, active params/token, #experts + expert size, attention type e.g. MLA, any MTP heads). Compute the theoretical single-stream tok/s ceiling on: H100 (~3.35 TB/s HBM3), H200 (~4.8 TB/s), B200 (~8 TB/s HBM3e), and a Cerebras WSE-class part (on-chip SRAM, tens of PB/s). Show how FP8/FP4/INT4 quantization and the MoE active-fraction shift the ceiling. State the fundamental constraint in one crisp sentence.' },
  { key: 'hardware', brief: 'Hardware landscape for serving a ~1T-param MoE FAST. Cerebras WSE-3 and Groq LPU win on speed via huge on-chip SRAM bandwidth but limited on-chip CAPACITY — can a 1T model (even 4-bit ≈ ~500GB) physically fit, across how many wafers/chips, at what cost? Contrast HBM accelerators (H200/B200, GB200 NVL72, AMD MI300X/MI325, TPU v6/v7) that have the capacity but far lower bandwidth. The core tradeoff: bandwidth (speed) vs capacity (fitting the model). Which real configuration could serve Kimi-K2.6-class at >800 tok/s single-stream, and what would it cost ($/hr, #chips)? Do Cerebras/Groq actually host a model this large, and if not, why?' },
  { key: 'serving-stack', brief: 'Software state of the art for fast large-MoE decode on GPUs: vLLM, SGLang, TensorRT-LLM. Expert parallelism (EP), tensor parallelism, FP8/FP4 weights + KV-cache quant, fused MoE kernels, disaggregated prefill/decode, continuous batching, CUDA graphs, prefix caching. What single-stream / low-batch tok/s do these ACTUALLY achieve for Kimi K2 or DeepSeek-V3/R1 (similar ~671B-1T MoE) on H200/B200 today? Where is the kernel + expert-routing overhead? What fraction of the memory-bandwidth ceiling does the best stack actually reach (efficiency %)?' },
  { key: 'spec-decoding', brief: 'Algorithmic accelerators that beat the per-token memory-bandwidth ceiling: speculative decoding (a small fast DRAFT model proposes tokens, the big K2.6 verifies many in parallel), EAGLE-2/3, Medusa, and multi-token prediction (MTP heads — DeepSeek/Kimi ship these). What end-to-end speedups are realistically achieved (2-4x?) and at what acceptance rate? Could draft+K2.6-verify realistically hit 800-1500 tok/s effective? This is the "fast model proposes, K2.6 is the smart verifier" path — quantify it. Also clarify how batch>1 throughput trades against single-stream latency for an interactive real-time UI (which needs low latency, batch≈1).' },
  { key: 'gap-and-bottleneck', brief: 'Quantify the GAP and name THE bottleneck. For Kimi-K2.6-class: theoretical optimal tok/s (memory-bandwidth ceiling on the best feasible hardware) vs what the best REAL system achieves today — give both numbers and the ratio (e.g. "optimal ~X, achieved ~Y, so Z% of optimal"). Then identify the SINGLE bottleneck that, if solved, most unlocks real-time: memory bandwidth (→ wafer-scale/SRAM), model size (→ smaller-but-smart / distillation), kernel+routing efficiency, or the sequential nature of decode (→ speculative/parallel). Be decisive — pick ONE primary bottleneck and defend it with the numbers.' },
  { key: 'practical-path', brief: 'The realistic path for a SMALL TEAM to get fast+smart now and near-future. Who hosts Kimi K2.6 and at what tok/s + $/Mtok (Fireworks, Together, DeepInfra, Novita, SiliconFlow, Baseten, Moonshot direct, Groq/Cerebras if any)? Self-host economics: rent B200/H200 (rough $/hr) + SGLang → what tok/s and $/Mtok, and break-even vs API. Lay out the pragmatic ladder: (a) fast smaller model now (gpt-oss class) accepting the intelligence gap, (b) pay for slow-but-smart K2.6 API, (c) self-host K2.6 + speculative decoding for fast+smart, (d) wait for B200/wafer-scale hosting. Recommend the route with rough cost + timeline.' },
]

const RESEARCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['dimension', 'keyFindings', 'bottleneckView', 'realtimeVerdict'],
  properties: {
    dimension: { type: 'string' },
    keyFindings: { type: 'array', items: { type: 'string' } },
    numbers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['metric', 'value'], properties: { metric: { type: 'string' }, value: { type: 'string' }, source: { type: 'string' } } } },
    bottleneckView: { type: 'string', description: 'what THIS dimension says the limiting bottleneck is' },
    realtimeVerdict: { type: 'string', description: 'can K2.6-class hit real-time (>800 tok/s single-stream) per this dimension, and why' },
    uncertainties: { type: 'array', items: { type: 'string' } },
  },
}

phase('Research')
const research = (await parallel(DIMS.map((d) => () =>
  agent(`${GOAL}\n\nYOUR DIMENSION = "${d.key}":\n${d.brief}\n\nResearch it (web search for current mid-2026 numbers), be QUANTITATIVE (formulas + figures), and return the schema. Commit to a realtimeVerdict, don't hedge.`,
    { label: `research:${d.key}`, phase: 'Research', schema: RESEARCH_SCHEMA })
))).filter(Boolean)

phase('Synthesize')
const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['theBottleneck', 'howFarFromOptimal', 'recommendedPath', 'realtimeFeasible'],
  properties: {
    theBottleneck: { type: 'string' },
    whyItsTheBottleneck: { type: 'string' },
    howFarFromOptimal: { type: 'string', description: 'theoretical optimal tok/s vs achieved, with numbers and the ratio' },
    hardwarePath: { type: 'string' },
    softwarePath: { type: 'string' },
    recommendedPath: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['step', 'detail'], properties: { step: { type: 'string' }, detail: { type: 'string' }, expectedSpeed: { type: 'string' }, cost: { type: 'string' } } } },
    realtimeFeasible: { type: 'string', enum: ['yes', 'near', 'no'] },
    keyNumbers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['metric', 'value'], properties: { metric: { type: 'string' }, value: { type: 'string' } } } },
  },
}
const synth = await agent(`You are the lead inference architect. Here are ${research.length} grounded research findings on serving a Kimi-K2.6-class MoE at real-time speed:\n\n${JSON.stringify(research, null, 1)}\n\nSynthesize decisively and quantitatively: (1) THE single bottleneck to solve for. (2) How far real systems are from the theoretical optimum, WITH NUMBERS (ceiling tok/s vs achieved tok/s and the ratio). (3) The recommended PATH for us to get fast+smart — concrete ordered steps (hardware, serving stack, speculative decoding, host vs self-host) with expected tok/s and rough cost per step. (4) Is real-time (>800 tok/s single-stream) Kimi-K2.6-class feasible: yes / near / no. Return the schema.`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA })

phase('Stress')
const STRESS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'challenges'],
  properties: { verdict: { type: 'string', enum: ['sound', 'shaky', 'wrong'] }, challenges: { type: 'array', items: { type: 'string' } }, corrections: { type: 'array', items: { type: 'string' } } },
}
const stress = (await parallel([1, 2].map((i) => () =>
  agent(`Be a skeptical senior inference engineer. The architect's synthesis:\n\n${JSON.stringify(synth, null, 1)}\n\nLens ${i}: ${i === 1 ? 'attack the NUMBERS and the bottleneck claim — are the tok/s ceilings, the optimal-vs-achieved gap, and the named bottleneck actually correct? Recompute from first principles where you doubt it.' : 'attack the RECOMMENDED PATH — is it actually feasible and affordable for a small team, and does it truly deliver fast AND smart, or is there a hidden blocker (capacity, cost, acceptance rate, availability)?'} Give concrete challenges and corrections. Return the schema.`,
    { label: `stress:${i}`, phase: 'Stress', schema: STRESS_SCHEMA })
))).filter(Boolean)

return { research, synthesis: synth, stress }
