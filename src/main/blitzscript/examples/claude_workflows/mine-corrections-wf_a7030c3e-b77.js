export const meta = {
  name: 'mine-corrections',
  description: 'Mine recurring user corrections from recent sessions into CLAUDE.md rule candidates',
  phases: [
    { title: 'Mine', detail: 'extract corrections per session chunk' },
    { title: 'Cluster', detail: 'group behavioral corrections into recurring themes' },
    { title: 'Verify', detail: 'adversarially confirm each recurs with evidence + check existing CLAUDE.md' },
    { title: 'Synthesize', detail: 'final ranked rule set with placement' },
  ],
}

const SESS = '/Users/minjunes/superapp/teenybase/agent-os/tmp/correction-mining/sessions'
const ROOT_MD = '/Users/minjunes/superapp/teenybase/CLAUDE.md'
const AOS_MD = '/Users/minjunes/superapp/teenybase/agent-os/CLAUDE.md'
const chunks = [
  { chunk: 1, files: ['17-669d331c.md', '08-3414fb24.md', '26-de3f23d1.md', '32-66ca41f9.md', '22-c7d1e3cf.md'] },
  { chunk: 2, files: ['41-e43ab2f6.md'] },
  { chunk: 3, files: ['27-050d4091.md', '35-efaf78fd.md', '28-575d0451.md', '20-a6681a40.md'] },
  { chunk: 4, files: ['24-0418bd62.md', '34-858f3d4f.md', '30-cf7773a7.md', '42-9fe6f289.md', '06-afed9bc4.md'] },
  { chunk: 5, files: ['07-78ff8252.md', '05-5d2d62a5.md', '01-b332a8a9.md', '03-e0dde74f.md'] },
  { chunk: 6, files: ['09-fab7e6e7.md', '10-dc54eb54.md', '29-012c6be4.md', '16-210b5d30.md', '19-89d635a0.md', '21-aef8daac.md'] },
  { chunk: 7, files: ['23-2263eaea.md', '37-1bc78983.md', '33-41e6d900.md', '36-63dcaa67.md', '12-96f78c73.md', '18-823f91c8.md'] },
  { chunk: 8, files: ['38-f1800a83.md', '14-46f585f0.md', '40-340ab99d.md'] },
  { chunk: 9, files: ['02-24d1ecb0.md'] },
  { chunk: 10, files: ['15-ed608781.md'] },
  { chunk: 11, files: ['04-7045d906.md'] },
  { chunk: 12, files: ['39-65bddcb5.md'] },
  { chunk: 13, files: ['11-ced8c5b0.md'] },
  { chunk: 14, files: ['25-bba8733e.md'] },
  { chunk: 15, files: ['31-a99fe5b5.md'] },
  { chunk: 16, files: ['13-f16dce49.md'] },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      description: 'Every genuine user correction found in the chunk. Empty array if none.',
      items: {
        type: 'object',
        required: ['quote', 'session_short', 'gist', 'category', 'is_behavioral', 'strength'],
        properties: {
          quote: { type: 'string', description: 'Verbatim user words, the actual correction, trimmed to <=240 chars.' },
          session_short: { type: 'string', description: '8-char session id from the file header/filename, e.g. f16dce49.' },
          gist: { type: 'string', description: 'One-line paraphrase of the behavior the user is correcting.' },
          category: { type: 'string', enum: ['prose-communication', 'verification-proof', 'root-cause-no-hacks', 'planning-process', 'subagent-use', 'tooling-commands', 'autonomy-scope', 'code-quality', 'perf-timing', 'context-memory', 'other'] },
          is_behavioral: { type: 'boolean', description: 'true ONLY if it is a generalizable rule about HOW Claude should work. false for one-off domain/feature/design requests.' },
          strength: { type: 'string', enum: ['mild', 'firm', 'frustrated'], description: 'Tone. frustrated/repeated is a stronger recurrence signal.' },
        },
      },
    },
  },
}

const CLUSTERS_SCHEMA = {
  type: 'object',
  required: ['themes'],
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'rule', 'category', 'distinct_sessions', 'occurrences', 'representative_quotes'],
        properties: {
          slug: { type: 'string', description: 'kebab-case id' },
          rule: { type: 'string', description: 'Concise imperative rule candidate. Siri prose. NO em dashes.' },
          category: { type: 'string' },
          distinct_sessions: { type: 'array', items: { type: 'string' }, description: 'distinct session_short ids where this recurs' },
          occurrences: { type: 'integer' },
          representative_quotes: { type: 'array', items: { type: 'string' }, description: '2-4 verbatim quotes, each prefixed with its session_short' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['keep', 'recurs_distinct_sessions', 'is_behavioral', 'already_in_claude_md', 'refined_rule', 'confirmed_quotes', 'reasoning'],
  properties: {
    keep: { type: 'boolean', description: 'true only if it genuinely recurs across >=2 distinct sessions AND is behavioral.' },
    recurs_distinct_sessions: { type: 'integer', description: 'real count of DISTINCT sessions with verified supporting evidence after re-checking.' },
    is_behavioral: { type: 'boolean' },
    already_in_claude_md: { type: 'string', enum: ['no', 'partial', 'yes'] },
    existing_rule_quote: { type: 'string', description: 'If partial/yes, the existing CLAUDE.md line(s). Empty if no.' },
    refined_rule: { type: 'string', description: 'Tightened rule text. Siri prose, NO em dashes.' },
    confirmed_quotes: { type: 'array', items: { type: 'string' }, description: 'Verbatim quotes that survived re-check, each prefixed with session_short.' },
    reasoning: { type: 'string' },
  },
}

const FINAL_SCHEMA = {
  type: 'object',
  required: ['rules', 'summary'],
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rule', 'status', 'placement', 'section', 'recurrence', 'sessions', 'quotes', 'rationale'],
        properties: {
          rule: { type: 'string', description: 'Final rule text, concise imperative, Siri prose, NO em dashes.' },
          status: { type: 'string', enum: ['NEW', 'STRENGTHEN', 'ALREADY_COVERED'] },
          placement: { type: 'string', enum: ['root-CLAUDE.md', 'agent-os-CLAUDE.md'] },
          section: { type: 'string', description: 'Suggested section/heading to place it under.' },
          recurrence: { type: 'integer', description: 'distinct-session count' },
          sessions: { type: 'array', items: { type: 'string' } },
          quotes: { type: 'array', items: { type: 'string' }, description: '2-3 verbatim quotes with session_short' },
          existing_rule: { type: 'string', description: 'If STRENGTHEN/ALREADY_COVERED, the current line and how to improve it. Empty for NEW.' },
          rationale: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

// ---- Phase 1: mine ----
phase('Mine')
const minePrompt = (c) => `You are mining a Claude Code conversation log for USER CORRECTIONS.

Read these compact session transcripts (each contains ONLY the human's typed turns, with a short snippet of the assistant text that preceded each, from the BlitzOS / teenybase repo):
${c.files.map(f => `  ${SESS}/${f}`).join('\n')}

Read every file fully with the Read tool. The 8-char session id is in each file's header ("session_id:") and filename (NN-<short>.md).

A CORRECTION is any human turn where the user:
- redirects or rejects what the assistant did ("no", "stop", "that's not what I meant", "undo that"),
- repeats an instruction the assistant already should have followed ("I told you", "again", "as I said"),
- expresses frustration about the assistant's behavior ("why did you", "you keep", "this is unacceptable"),
- or states a preference about HOW the assistant should work (communication, planning, verification, tool use, code quality, autonomy, performance).

For EACH correction emit one finding: verbatim quote (trim to <=240 chars, keep the essential correcting words), session_short, a one-line gist, category, strength, and is_behavioral.

CRITICAL: set is_behavioral=true ONLY when the correction generalizes into a durable rule about how the assistant should work. Set is_behavioral=false for one-off domain/feature/design/bug requests (e.g. "make the wallpaper lighter", "add ctrl-arrow desktop switching", "the chat widget is not embedded"). When unsure, lean false.

Do NOT invent findings. Only real corrections actually present in the user's turns. A pure new-feature request with no correcting tone is NOT a finding. Return all findings via the structured schema.`

const mined = await parallel(chunks.map(c => () =>
  agent(minePrompt(c), { label: `mine:c${c.chunk}`, phase: 'Mine', schema: FINDINGS_SCHEMA })
))
const allFindings = mined.filter(Boolean).flatMap(r => (r && r.findings) ? r.findings : [])
const behavioral = allFindings.filter(f => f && f.is_behavioral)
log(`mined ${allFindings.length} corrections; ${behavioral.length} behavioral, ${allFindings.length - behavioral.length} one-off (dropped)`)

// ---- Phase 2: cluster ----
phase('Cluster')
const clusterPrompt = `You are clustering user corrections to find the ones the user makes REPEATEDLY across different sessions.

Here are ${behavioral.length} behavioral correction findings mined from ${chunks.length} chunks of recent sessions (JSON):
${JSON.stringify(behavioral)}

Group synonymous corrections into themes. Example: "explain shortly" + "more plainly" + "too verbose" + "I don't get this, shorter" all collapse into ONE "be concise / explain plainly" theme.

A theme is worth surfacing ONLY if it recurs across >=2 DISTINCT sessions (count distinct session_short values), OR appears many times overall with clear frustration. Drop singletons unless extremely strong.

For each surviving theme produce: slug, a concise imperative rule candidate (Siri prose, NO em dashes), category, distinct_sessions (the list of distinct session_short ids), occurrences (total count), and 2-4 representative verbatim quotes each prefixed with "<session_short>: ".

Be honest about counts. Do not merge unrelated corrections just to inflate recurrence. Return via the schema.`

const clusters = await agent(clusterPrompt, { label: 'cluster', phase: 'Cluster', schema: CLUSTERS_SCHEMA })
const themes = (clusters && clusters.themes) ? clusters.themes : []
log(`clustered into ${themes.length} candidate recurring themes`)

// ---- Phase 3: adversarial verify (one per theme) ----
phase('Verify')
const verifyPrompt = (t) => `You are an ADVERSARIAL verifier. A clustering pass claims the following is a recurring user correction. Your job is to try to REFUTE it, and only confirm if the evidence is real.

CLAIMED THEME:
  rule: ${t.rule}
  slug: ${t.slug}
  claimed distinct sessions: ${JSON.stringify(t.distinct_sessions)}
  claimed occurrences: ${t.occurrences}
  representative quotes: ${JSON.stringify(t.representative_quotes)}

Evidence lives in compact human-turn transcripts at: ${SESS}  (files named NN-<short>.md).

Do this:
1. Verify the quotes are REAL. For each claimed quote, grep the sessions dir for a distinctive phrase from it, e.g.:  grep -rn "distinctive phrase" ${SESS}
   Confirm it is in a USER turn (a "**USER:**" line), not assistant text, and note which session file (NN-<short>.md) it is in.
2. Count how many DISTINCT sessions genuinely contain this correction. Do not count the same session twice. Do not count assistant text or your own paraphrase.
3. Decide is_behavioral: is this a durable rule about HOW the assistant should work, or a one-off domain request mislabeled?
4. Check whether this is ALREADY a rule in CLAUDE.md. Read BOTH files fully and search for an equivalent:
     ${ROOT_MD}
     ${AOS_MD}
   Set already_in_claude_md to "yes" (clearly covered), "partial" (related but weaker/vaguer), or "no". If yes/partial, quote the existing line in existing_rule_quote.

DEFAULT to keep=false if recurrence is <2 distinct verified sessions, or if it is not behavioral, or if the quotes do not check out. Set keep=true only when it survives all checks.

Provide: keep, recurs_distinct_sessions (the real verified count), is_behavioral, already_in_claude_md, existing_rule_quote, refined_rule (tightened, Siri prose, NO em dashes), confirmed_quotes (verbatim, each prefixed with "<session_short>: "), and reasoning. Return via the schema.`

const verified = await parallel(themes.map(t => () =>
  agent(verifyPrompt(t), { label: `verify:${t.slug}`, phase: 'Verify', schema: VERDICT_SCHEMA })
    .then(v => ({ theme: t, verdict: v }))
    .catch(() => null)
))
const confirmed = verified.filter(Boolean).filter(x => x.verdict && x.verdict.keep)
log(`verified: ${confirmed.length}/${themes.length} themes survived adversarial check`)

// ---- Phase 4: synthesize final rule set ----
phase('Synthesize')
const synthPrompt = `You are producing the final set of CLAUDE.md rule proposals from verified recurring user corrections.

VERIFIED THEMES (each with its adversarial verdict), JSON:
${JSON.stringify(confirmed.map(x => ({ rule: x.theme.rule, category: x.theme.category, verdict: x.verdict })))}

Read BOTH existing CLAUDE.md files FULLY before deciding anything:
  ${ROOT_MD}        (root teenybase rules: general working style)
  ${AOS_MD}         (agent-os/BlitzOS specific rules)

For each verified theme, produce one final rule entry:
- rule: final text. Concise, imperative, actionable. Siri-style prose. ABSOLUTELY NO EM DASHES (the user has a hard style rule against them); use commas, periods, or parentheses instead.
- status: NEW (not meaningfully in either file), STRENGTHEN (a weaker/vaguer version exists but the user keeps repeating it, so reword/sharpen/elevate it), or ALREADY_COVERED (adequately covered already; list for awareness, do not propose adding).
- placement: root-CLAUDE.md for general working style, agent-os-CLAUDE.md for BlitzOS-specific behavior.
- section: the existing heading it best fits under (quote a real heading from the file you read).
- recurrence: the verified distinct-session count from the verdict.
- sessions: the distinct session_short ids.
- quotes: 2-3 verbatim quotes (from confirmed_quotes), each prefixed with session_short.
- existing_rule: for STRENGTHEN/ALREADY_COVERED, quote the current line and say briefly how to improve it. Empty for NEW.
- rationale: one or two sentences on why this earns a rule.

Rank rules by severity*recurrence (most important first). Prefer STRENGTHEN/merge over adding near-duplicates; both files are already long, so do not bloat them. Also write a 'summary' (3-5 sentences): the headline recurring patterns, how many are genuinely NEW vs already-covered-but-ignored, and any meta-observation (e.g. the user keeps re-stating rules that already exist, which suggests a prominence/placement problem). Return via the schema.`

const final = await agent(synthPrompt, { label: 'synthesize', phase: 'Synthesize', schema: FINAL_SCHEMA })

return {
  counts: {
    total_findings: allFindings.length,
    behavioral: behavioral.length,
    candidate_themes: themes.length,
    confirmed_themes: confirmed.length,
    final_rules: final && final.rules ? final.rules.length : 0,
  },
  final,
}