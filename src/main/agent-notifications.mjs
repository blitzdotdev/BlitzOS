const DONE_STATUSES = new Set(['watching', 'idle'])
const liveNotifications = new Set()

function cleanTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 48)
}

export function isAgentDoneTransition(previousStatus, status) {
  return String(previousStatus || '') === 'working' && DONE_STATUSES.has(String(status || ''))
}

export function isAgentResponseNeededTransition(previousStatus, status) {
  return String(previousStatus || '') !== 'waiting' && String(status || '') === 'waiting'
}

export function isAgentErrorTransition(previousStatus, status) {
  return String(previousStatus || '') !== 'error' && String(status || '') === 'error'
}

export function agentStatusNotificationKind(previousStatus, status) {
  if (isAgentDoneTransition(previousStatus, status)) return 'done'
  if (isAgentResponseNeededTransition(previousStatus, status)) return 'response-needed'
  if (isAgentErrorTransition(previousStatus, status)) return 'error'
  return null
}

export function agentDoneNotificationCopy(agentTitle) {
  return agentStatusNotificationCopy('done', agentTitle)
}

export function agentStatusNotificationCopy(kind, agentTitle) {
  const title = cleanTitle(agentTitle) || 'Agent'
  if (kind === 'response-needed') {
    return {
      title: `${title} needs a response`,
      body: 'Click to respond in BlitzOS.'
    }
  }
  if (kind === 'error') {
    return {
      title: `${title} ran into an error`,
      body: 'Click to check in BlitzOS.'
    }
  }
  return {
    title: `${title} is done`,
    body: 'Click to review the result in BlitzOS.'
  }
}

export function showAgentDoneNotification({ Notification, agentTitle, onClick, onError, onShow } = {}) {
  return showAgentStatusNotification({ Notification, kind: 'done', agentTitle, onClick, onError, onShow })
}

export function showAgentStatusNotification({ Notification, kind = 'done', agentTitle, onClick, onError, onShow } = {}) {
  if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return false
  const copy = agentStatusNotificationCopy(kind, agentTitle)
  try {
    const n = new Notification({ title: copy.title, body: copy.body })
    liveNotifications.add(n)
    const release = () => liveNotifications.delete(n)
    n.once?.('show', () => {
      try { onShow?.() } catch { /* observers must not break notification cleanup */ }
    })
    n.once?.('click', () => {
      release()
      try { onClick?.() } catch { /* notification click handlers are best-effort */ }
    })
    n.once?.('close', release)
    n.once?.('failed', (_event, error) => {
      release()
      try { onError?.(error) } catch { /* observers must not break notification cleanup */ }
    })
    n.show()
    return true
  } catch (e) {
    try { onError?.(e) } catch { /* observers must not break notification cleanup */ }
    return false
  }
}

export function _liveNotificationCountForTest() {
  return liveNotifications.size
}
