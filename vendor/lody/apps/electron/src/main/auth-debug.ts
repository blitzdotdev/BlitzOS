import type { BrowserWindow } from 'electron'
import { getMainWindow } from './window-state'

const AUTH_DEBUG_PREFIX = '[electron-auth-debug]'
const AUTH_DEBUG_CHANNEL = 'lody:auth-debug'
const MAX_PENDING_RENDERER_EVENTS = 100

type AuthDebugMeta = Record<string, unknown>

type AuthDebugEvent = {
  source: 'electron-main'
  timestamp: string
  message: string
  meta?: AuthDebugMeta
}

const pendingRendererEvents: AuthDebugEvent[] = []

function enqueueRendererEvent(event: AuthDebugEvent): void {
  pendingRendererEvents.push(event)
  if (pendingRendererEvents.length > MAX_PENDING_RENDERER_EVENTS) {
    pendingRendererEvents.shift()
  }
}

function sendToRenderer(window: BrowserWindow | null, event: AuthDebugEvent): boolean {
  if (!window || window.isDestroyed()) {
    return false
  }

  const contents = window.webContents
  if (contents.isDestroyed() || contents.isLoading()) {
    return false
  }

  const currentUrl = contents.getURL()
  if (!currentUrl || currentUrl === 'about:blank') {
    return false
  }

  contents.send(AUTH_DEBUG_CHANNEL, event)
  return true
}

export function flushAuthDebugEventsToRenderer(window = getMainWindow()): void {
  if (pendingRendererEvents.length === 0) {
    return
  }

  const events = pendingRendererEvents.splice(0)
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (!event) {
      continue
    }
    if (!sendToRenderer(window, event)) {
      for (let pendingIndex = index; pendingIndex < events.length; pendingIndex += 1) {
        const pendingEvent = events[pendingIndex]
        if (pendingEvent) {
          enqueueRendererEvent(pendingEvent)
        }
      }
      break
    }
  }
}

export function logAuthDebug(message: string, meta?: AuthDebugMeta): void {
  const event: AuthDebugEvent = {
    source: 'electron-main',
    timestamp: new Date().toISOString(),
    message,
    ...(meta ? { meta } : {})
  }

  if (meta) {
    console.info(AUTH_DEBUG_PREFIX, message, meta)
  } else {
    console.info(AUTH_DEBUG_PREFIX, message)
  }

  if (!sendToRenderer(getMainWindow(), event)) {
    enqueueRendererEvent(event)
  }
}

export function describeUrlForAuthDebug(rawUrl: string | null | undefined): AuthDebugMeta {
  if (rawUrl == null || rawUrl.length === 0) {
    return {
      present: false
    }
  }

  try {
    const parsed = new URL(rawUrl)
    const hashParams = parsed.hash.startsWith('#')
      ? new URLSearchParams(parsed.hash.slice(1))
      : new URLSearchParams()
    const searchKeys = Array.from(parsed.searchParams.keys())
    const hashKeys = Array.from(hashParams.keys())
    const token = hashParams.get('token')

    return {
      present: true,
      protocol: parsed.protocol,
      host: parsed.host,
      pathname: parsed.pathname,
      hasSearch: parsed.search.length > 0,
      searchKeys,
      hasHash: parsed.hash.length > 0,
      hashKeys,
      hasToken: typeof token === 'string' && token.length > 0,
      tokenLength: token?.length ?? 0,
      urlLength: rawUrl.length
    }
  } catch (error) {
    return {
      present: true,
      parseError: error instanceof Error ? error.message : String(error),
      urlLength: rawUrl.length
    }
  }
}

export function describeDeepLinkForAuthDebug(rawUrl: string | null | undefined): AuthDebugMeta {
  return {
    ...describeUrlForAuthDebug(rawUrl),
    isLodyProtocol: typeof rawUrl === 'string' && /^lody:\/\//i.test(rawUrl.trim())
  }
}
