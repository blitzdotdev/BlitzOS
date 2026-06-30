import assert from 'node:assert/strict'
import {
  _liveNotificationCountForTest,
  agentDoneNotificationCopy,
  agentStatusNotificationCopy,
  agentStatusNotificationKind,
  isAgentDoneTransition,
  isAgentErrorTransition,
  isAgentResponseNeededTransition,
  showAgentStatusNotification,
  showAgentDoneNotification
} from '../../src/main/agent-notifications.mjs'

assert.equal(isAgentDoneTransition('working', 'watching'), true)
assert.equal(isAgentDoneTransition('working', 'idle'), true)
assert.equal(isAgentDoneTransition('working', 'waiting'), false)
assert.equal(isAgentDoneTransition('working', 'error'), false)
assert.equal(isAgentDoneTransition('starting', 'watching'), false)
assert.equal(isAgentDoneTransition('watching', 'watching'), false)
assert.equal(isAgentDoneTransition('idle', 'watching'), false)

assert.equal(isAgentResponseNeededTransition('working', 'waiting'), true)
assert.equal(isAgentResponseNeededTransition('watching', 'waiting'), true)
assert.equal(isAgentResponseNeededTransition('waiting', 'waiting'), false)
assert.equal(isAgentResponseNeededTransition('working', 'watching'), false)

assert.equal(isAgentErrorTransition('working', 'error'), true)
assert.equal(isAgentErrorTransition('waiting', 'error'), true)
assert.equal(isAgentErrorTransition('error', 'error'), false)
assert.equal(isAgentErrorTransition('working', 'waiting'), false)

assert.equal(agentStatusNotificationKind('working', 'watching'), 'done')
assert.equal(agentStatusNotificationKind('working', 'idle'), 'done')
assert.equal(agentStatusNotificationKind('working', 'waiting'), 'response-needed')
assert.equal(agentStatusNotificationKind('watching', 'waiting'), 'response-needed')
assert.equal(agentStatusNotificationKind('working', 'error'), 'error')
assert.equal(agentStatusNotificationKind('waiting', 'error'), 'error')
assert.equal(agentStatusNotificationKind('waiting', 'waiting'), null)
assert.equal(agentStatusNotificationKind('error', 'error'), null)
assert.equal(agentStatusNotificationKind('idle', 'watching'), null)

assert.deepEqual(agentDoneNotificationCopy('Research Agent'), {
  title: 'Research Agent is done',
  body: 'Click to review the result in BlitzOS.'
})
assert.deepEqual(agentDoneNotificationCopy('   '), {
  title: 'Agent is done',
  body: 'Click to review the result in BlitzOS.'
})
assert.deepEqual(agentStatusNotificationCopy('response-needed', 'Research Agent'), {
  title: 'Research Agent needs a response',
  body: 'Click to respond in BlitzOS.'
})
assert.deepEqual(agentStatusNotificationCopy('error', 'Research Agent'), {
  title: 'Research Agent ran into an error',
  body: 'Click to check in BlitzOS.'
})
assert.deepEqual(agentStatusNotificationCopy('error', '   '), {
  title: 'Agent ran into an error',
  body: 'Click to check in BlitzOS.'
})

class FakeNotification {
  static supported = true
  static shown = []

  constructor(options) {
    this.options = options
    this.handlers = {}
    this.shown = false
    FakeNotification.shown.push(this)
  }

  static isSupported() {
    return this.supported
  }

  once(event, listener) {
    this.handlers[event] = listener
    return this
  }

  show() {
    this.shown = true
    this.emit('show')
  }

  emit(event, ...args) {
    this.handlers[event]?.({ type: event }, ...args)
  }
}

let clicked = false
let shown = false
assert.equal(_liveNotificationCountForTest(), 0)
assert.equal(showAgentDoneNotification({
  Notification: FakeNotification,
  agentTitle: 'Blitz',
  onClick: () => { clicked = true },
  onShow: () => { shown = true }
}), true)
assert.equal(FakeNotification.shown.length, 1)
assert.equal(FakeNotification.shown[0].shown, true)
assert.equal(shown, true)
assert.equal(FakeNotification.shown[0].options.title, 'Blitz is done')
assert.equal(_liveNotificationCountForTest(), 1)
FakeNotification.shown[0].emit('click')
assert.equal(clicked, true)
assert.equal(_liveNotificationCountForTest(), 0)

assert.equal(showAgentStatusNotification({
  Notification: FakeNotification,
  kind: 'response-needed',
  agentTitle: 'Blitz'
}), true)
assert.equal(FakeNotification.shown.at(-1).options.title, 'Blitz needs a response')
FakeNotification.shown.at(-1).emit('close')
assert.equal(_liveNotificationCountForTest(), 0)

assert.equal(showAgentStatusNotification({
  Notification: FakeNotification,
  kind: 'error',
  agentTitle: 'Blitz'
}), true)
assert.equal(FakeNotification.shown.at(-1).options.title, 'Blitz ran into an error')
FakeNotification.shown.at(-1).emit('close')
assert.equal(_liveNotificationCountForTest(), 0)

FakeNotification.supported = false
assert.equal(showAgentDoneNotification({ Notification: FakeNotification, agentTitle: 'Blitz' }), false)
assert.equal(_liveNotificationCountForTest(), 0)

let failedReason = null
FakeNotification.supported = true
assert.equal(showAgentDoneNotification({
  Notification: FakeNotification,
  agentTitle: 'Blitz',
  onError: (error) => { failedReason = error }
}), true)
FakeNotification.shown.at(-1).emit('failed', 'native delivery failed')
assert.equal(failedReason, 'native delivery failed')
assert.equal(_liveNotificationCountForTest(), 0)

console.log('PASS — agent notification done-edge helper')
