#!/usr/bin/env node
import { sanitizeActivityEvent, sanitizeToolActivity } from '../../src/main/activity-logging.mjs'

let failed = 0
function ok(name, cond, detail = '') {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failed++
}

const bannedKeys = ['messages', 'text', 'title', 'url', 'path', 'args', 'result', 'stack', 'terminal-data', 'email', 'token']
const hasBannedKey = (obj) => bannedKeys.some((key) => Object.prototype.hasOwnProperty.call(obj || {}, key))

console.log('activity-logging sanitizer')

ok('unknown event names are dropped', sanitizeActivityEvent('chat.raw_text', { text: 'secret' }, { salt: 'test' }) === null)

const chat = sanitizeActivityEvent(
  'chat.message_sent',
  {
    agentId: 'agent-7',
    messageLength: 184,
    hasAttachments: true,
    attachmentCount: 2,
    text: 'my private message',
    messages: [{ role: 'user', text: 'private' }],
    title: 'secret doc',
    url: 'https://example.com/private/path?token=abc',
    path: '/Users/brandonhresko/private.txt',
    email: 'person@example.com',
    token: 'sk-secret',
    stack: 'Error: no'
  },
  { salt: 'test' }
)

ok('chat event survives with safe metadata', chat?.name === 'chat.message_sent')
ok('chat text and PII-ish props are removed', !hasBannedKey(chat?.props), JSON.stringify(chat?.props))
ok('agent id is salted-hashed, not raw', typeof chat?.props.agentIdHash === 'string' && chat.props.agentIdHash !== 'agent-7')
ok('message length is bucketed', chat?.props.messageLengthBucket === '81-280')
ok('attachment metadata is retained', chat?.props.hasAttachments === true && chat.props.attachmentCount === 2)

const tool = sanitizeToolActivity(
  {
    path: '/read_window',
    status: 200,
    ok: true,
    ms: 321,
    args: { url: 'https://example.com/private' },
    result: { text: 'private page content' }
  },
  { salt: 'test' }
)

ok('tool event records safe path/status/ms metadata', tool?.props.tool === '/read_window' && tool.props.statusCode === 200 && tool.props.msBucket === '100-500ms')
ok('tool args/results/raw path key are not retained', !hasBannedKey(tool?.props), JSON.stringify(tool?.props))

const appCard = sanitizeActivityEvent('app_card.opened', { agentId: '3', title: 'Dashboard', url: 'https://thing.app.blitz.dev/x' }, { salt: 'test' })
ok('app card event drops titles and URLs', appCard?.name === 'app_card.opened' && !hasBannedKey(appCard?.props), JSON.stringify(appCard?.props))

const onboarding = sanitizeActivityEvent('onboarding.step_viewed', { step: 'permissions', count: 3, total: 6, copy: 'Welcome' }, { salt: 'test' })
ok('onboarding step records enum/counts only', onboarding?.props.step === 'permissions' && onboarding.props.count === 3 && !('copy' in onboarding.props))

console.log(failed ? `\n${failed} FAILURES` : '\nall green')
process.exit(failed ? 1 : 0)
