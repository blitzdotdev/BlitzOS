// test-chat-titleer.mjs — no real Claude calls. Validates the auto-title helper's parsing, sanitizing,
// timeout fallback, and Claude invocation contract through an injected runner.
import {
  AGENT_TITLE_MAX,
  AGENT_TITLE_SCHEMA,
  buildAgentTitlePrompt,
  generateAgentTitle,
  parseClaudeTitleOutput,
  sanitizeAgentTitle
} from '../../src/main/chat-titleer.mjs'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}

console.log('chat-titleer:')

ok('sanitizes quotes, markdown, whitespace, trailing punctuation, and clamps to 24 chars',
  sanitizeAgentTitle('  **"Research Google Docs sharing permissions immediately!!!"**  ') === 'Research Google Docs',
  sanitizeAgentTitle('  **"Research Google Docs sharing permissions immediately!!!"**  '))

ok('rejects empty sanitized values',
  sanitizeAgentTitle('   ```   ') === '')

ok('parses Claude structured_output',
  parseClaudeTitleOutput(JSON.stringify({ structured_output: { title: 'Drive Sharing' } })) === 'Drive Sharing')

ok('parses the last JSON line from noisy output',
  parseClaudeTitleOutput(`noise\n${JSON.stringify({ structured_output: { title: 'Browser Speed' } })}`) === 'Browser Speed')

ok('parses JSON title from result fallback',
  parseClaudeTitleOutput(JSON.stringify({ result: JSON.stringify({ title: 'Docs Editing' }) })) === 'Docs Editing')

{
  let seen = null
  const title = await generateAgentTitle({
    agentId: '7',
    text: 'Can you help me share this Google Doc with Palash and make sure he has edit access?',
    workspacePath: '/tmp/blitz-title-test',
    runClaude: async (input) => {
      seen = input
      return JSON.stringify({ structured_output: { title: 'Share Google Doc' } })
    },
    logger: { warn() {} }
  })
  ok('generateAgentTitle returns sanitized title from injected Claude runner', title === 'Share Google Doc', title)
  ok('generateAgentTitle sends the title schema and workspace cwd to the runner',
    seen && seen.schema === AGENT_TITLE_SCHEMA && seen.cwd === '/tmp/blitz-title-test' && seen.prompt.includes('User first message:'), seen)
  ok('prompt includes the 24-character limit',
    buildAgentTitlePrompt('hello').includes(`${AGENT_TITLE_MAX} characters or fewer`))
}

{
  let warned = false
  const title = await generateAgentTitle({
    agentId: '8',
    text: 'Please build a quick dashboard',
    timeoutMs: 1000,
    runClaude: async () => new Promise(() => {}),
    logger: { warn() { warned = true } }
  })
  ok('timeout/failure returns null instead of surfacing a chat error', title === null && warned, { title, warned })
}

console.log(`\n${failures === 0 ? 'PASS' : failures + ' FAILED'} — chat-titleer`)
process.exit(failures === 0 ? 0 : 1)
