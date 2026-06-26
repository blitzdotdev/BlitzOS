import { spawn } from 'node:child_process'

export const AGENT_TITLE_MAX = 24
export const AGENT_TITLE_TIMEOUT_MS = Math.max(5000, Number(process.env.BLITZ_AGENT_TITLE_TIMEOUT_MS) || 20000)

export const AGENT_TITLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      description: 'A short 2-5 word title for this chat.'
    }
  },
  required: ['title']
}

function tail(text, max = 1200) {
  const s = String(text || '').trim()
  return s.length > max ? `...${s.slice(-max)}` : s
}

function tryJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function clampTitle(text, max = AGENT_TITLE_MAX) {
  const s = String(text || '').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max + 1)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace >= 8 ? cut.slice(0, lastSpace) : cut.slice(0, max)).trim()
}

export function sanitizeAgentTitle(value, max = AGENT_TITLE_MAX) {
  let title = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^```(?:json|text)?/i, '')
    .replace(/```$/i, '')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()

  title = title.replace(/^title\s*:\s*/i, '').trim()

  for (let i = 0; i < 3; i++) {
    const next = title
      .replace(/^[`"'“”‘’*_\s]+/, '')
      .replace(/[`"'“”‘’*_\s]+$/, '')
      .replace(/[.!?:;,，。！？]+$/u, '')
      .trim()
    if (next === title) break
    title = next
  }

  return clampTitle(title, max)
}

export function buildAgentTitlePrompt(firstMessage) {
  const text = String(firstMessage || '').trim().slice(0, 4000)
  return [
    'Generate a short title for a BlitzOS agent chat from the user\'s first message.',
    '',
    'Rules:',
    '- 2 to 5 words.',
    `- ${AGENT_TITLE_MAX} characters or fewer.`,
    '- No quotes, punctuation at the end, markdown, emoji, or filler words like "Chat".',
    '- Prefer concrete task nouns.',
    '',
    'User first message:',
    text
  ].join('\n')
}

function titleFromObject(obj) {
  if (!obj || typeof obj !== 'object') return ''
  if (obj.structured_output && typeof obj.structured_output === 'object') return obj.structured_output.title
  if (obj.output && typeof obj.output === 'object') return obj.output.title
  if (typeof obj.title === 'string') return obj.title
  if (typeof obj.result === 'string') {
    const nested = tryJson(obj.result.trim())
    if (nested) return titleFromObject(nested)
    return obj.result
  }
  return ''
}

export function parseClaudeTitleOutput(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return ''

  const whole = tryJson(text)
  if (whole) return sanitizeAgentTitle(titleFromObject(whole))

  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = tryJson(lines[i].trim())
    const title = sanitizeAgentTitle(titleFromObject(obj))
    if (title) return title
  }
  return sanitizeAgentTitle(text)
}

export function runClaudeTitle({ prompt, schema = AGENT_TITLE_SCHEMA, cwd, timeoutMs = AGENT_TITLE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', String(prompt || ''), '--model', 'haiku', '--output-format', 'json', '--json-schema', JSON.stringify(schema)]
    const child = spawn('claude', args, {
      cwd: cwd || undefined,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    let err = ''
    let settled = false
    let timedOut = false
    const done = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }, Math.max(1000, Number(timeoutMs) || AGENT_TITLE_TIMEOUT_MS))
    if (typeof timer.unref === 'function') timer.unref()

    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => done(reject, e))
    child.on('close', (code) => {
      if (timedOut) return done(reject, new Error('Claude title generation timed out'))
      if (code === 0) {
        return done(resolve, out)
      }
      const detail = [err && tail(err), out && tail(out)].filter(Boolean).join('\n')
      done(reject, new Error(`Claude title generation exited ${code}${detail ? `\n${detail}` : ''}`))
    })
  })
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Claude title generation timed out')), Math.max(1000, Number(timeoutMs) || AGENT_TITLE_TIMEOUT_MS))
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

export async function generateAgentTitle({ text, agentId, workspacePath, timeoutMs = AGENT_TITLE_TIMEOUT_MS, runClaude = runClaudeTitle, logger = null } = {}) {
  const firstMessage = String(text || '').trim()
  if (!firstMessage) return null
  const startedAt = Date.now()
  try {
    const stdout = await withTimeout(runClaude({
      prompt: buildAgentTitlePrompt(firstMessage),
      schema: AGENT_TITLE_SCHEMA,
      cwd: workspacePath,
      timeoutMs
    }), timeoutMs)
    const title = parseClaudeTitleOutput(stdout)
    return title || null
  } catch (e) {
    try { logger?.warn?.('[chat-titleer] auto-title failed', { agentId: agentId == null ? '' : String(agentId), ms: Date.now() - startedAt, timeoutMs, error: e?.message || String(e) }) } catch { /* logging only */ }
    return null
  }
}
