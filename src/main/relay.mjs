// The agent-socket relay LIFECYCLE — ONE implementation for BOTH transports (Electron main via
// agentSocket.ts, and the server via preview/backend.mjs), so it can NEVER diverge again. This was the
// last place the two drifted: the self-heal (never-give-up reconnect + adopt-the-new-url-on-reconnect +
// a watchdog backstop + boot retry + the online/offline status) was added to the server only, leaving
// Electron with the silent-offline bug. It now lives here once; both modes call startRelay().
//
// The only thing that differs per transport is the `adapter` (how to publish the URL / status) — the
// os-tools.mjs `makeOsTools(ops)` pattern, applied to the relay.
import { connect } from '@agent-socket/sdk'

/**
 * Connect to the agent-socket relay and keep the connection healthy forever.
 * @param {object} cfg   { appId, baseUrl, appDescription, agentsMd, tools, label? } — tools is the SDK-shaped array
 * @param {object} adapter { onUrl(url), onStatus(online, url) } — platform-specific publish of the URL/status
 * @returns {{ getUrl: () => (string|null), isOnline: () => boolean, stop: () => void }}
 */
export function startRelay(cfg, adapter = {}) {
  const label = cfg.label || 'blitzos'
  let session = null
  let url = null
  let lastOkAt = Date.now()

  const status = (online) => {
    if (online) lastOkAt = Date.now()
    try {
      adapter.onStatus && adapter.onStatus(online, url)
    } catch {
      /* best-effort UI ping */
    }
  }
  const publishUrl = () => {
    try {
      adapter.onUrl && adapter.onUrl(url)
    } catch {
      /* best-effort */
    }
  }

  async function connectOnce() {
    try {
      session = await connect({
        appId: cfg.appId,
        baseUrl: cfg.baseUrl,
        appDescription: cfg.appDescription,
        agentsMd: cfg.agentsMd,
        // NEVER give up reconnecting (exponential 1s→30s); flip the UI to "offline" the instant the WS drops.
        onDisconnect: ({ attempt, reconnect }) => {
          status(false)
          setTimeout(reconnect, Math.min(30_000, 1000 * Math.pow(2, Math.max(0, attempt - 1))))
        },
        // A reconnect mints a NEW session URL — adopt it (the old one is dead on the relay) + publish it.
        // publishUrl() refreshes .blitzos/relay-url, so the running agent terminals (which re-read it per
        // call) self-heal onto the fresh url — no privileged brain to restart.
        onSessionChanged: async (info) => {
          const next = info && info.tokensRemapped && info.tokensRemapped.get(url)
          if (next) url = next
          else {
            try {
              url = (await session.mintAgentToken({ label })).url
            } catch {
              /* keep the old URL; the watchdog will force a fresh connect */
            }
          }
          status(true)
          publishUrl()
        },
        tools: cfg.tools
      })
      url = (await session.mintAgentToken({ label })).url
      status(true)
      publishUrl()
    } catch (e) {
      status(false)
      // Relay may be briefly down at boot — keep trying instead of giving up (the old code gave up here).
      setTimeout(connectOnce, 5000)
    }
  }
  connectOnce()

  // Watchdog: heartbeat the status every 20s, and as a HARD backstop force a fresh connect if the WS has been
  // wedged for >90s (the SDK normally self-reconnects via onDisconnect; this catches the rare stuck case).
  const watchdog = setInterval(() => {
    const online = !!(session && session.connected)
    status(online)
    if (!online && Date.now() - lastOkAt > 90_000) {
      lastOkAt = Date.now()
      try {
        session && session.close && session.close()
      } catch {
        /* already gone */
      }
      session = null
      connectOnce()
    }
  }, 20_000)
  if (watchdog.unref) watchdog.unref()

  return {
    getUrl: () => url,
    isOnline: () => !!(session && session.connected),
    stop: () => {
      clearInterval(watchdog)
      try {
        session && session.close && session.close()
      } catch {
        /* already gone */
      }
    }
  }
}
