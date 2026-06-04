/*
 * Browser `window.agentOS` over fetch + SSE (not Electron IPC) for the preview.
 *
 * Implements the surface-model preload API the renderer expects:
 *   onAction(cb)        - agent actions (create/move/close/goToPrimary) via SSE
 *   sendState(state)    - renderer pushes its surface list (so list_state works)
 *   onAgentSocketUrl(cb)- the agent-socket paste URL ("Connect AI")
 *   registerWebview/unregisterWebview - no-op (no CDP/<webview> in a browser)
 *   integrations.*      - real OAuth via the /api backend
 *
 * Backed by preview/backend.mjs through the Vite `/api` proxy. Injected only by
 * vite.renderer.preview.mjs; guards on an existing window.agentOS (inert in Electron).
 *
 * Limitation vs the desktop app: `web` surfaces render as empty framed windows
 * (no <webview>) and in-window control (surface_control/CDP) is unavailable here.
 */
;(function () {
  if (window.agentOS) return // real Electron preload present — never override it

  var API = '/api'
  var integ = [] // onUpdated listeners
  var actionL = [] // onAction listeners
  var urlL = [] // onAgentSocketUrl listeners
  var es = null

  function getJSON(path, opts) {
    return fetch(API + path, opts).then(function (r) { return r.json() })
  }
  function fire(list, arg) {
    list.slice().forEach(function (cb) { try { cb(arg) } catch (e) { /* ignore */ } })
  }

  // One shared SSE stream carries both agent actions and the agent-socket URL.
  function ensureES() {
    if (es) return
    try {
      es = new EventSource(API + '/os/events')
    } catch (e) {
      return
    }
    es.onmessage = function (ev) {
      var msg
      try { msg = JSON.parse(ev.data) } catch (e) { return }
      if (msg && msg.__agentUrl) { fire(urlL, msg.__agentUrl); return }
      if (msg && msg.type) fire(actionL, msg)
    }
  }

  // OAuth: open popup synchronously (preserve gesture), then poll until connected.
  function pollConnected(id, popup) {
    return new Promise(function (resolve) {
      var tries = 0
      var iv = setInterval(function () {
        tries++
        getJSON('/integrations').then(function (list) {
          var it = (list || []).find(function (x) { return x.id === id })
          if (it && it.connected) { clearInterval(iv); fire(integ); resolve({ ok: true, label: it.label }) }
          else if (tries > 120) { clearInterval(iv); resolve({ ok: false, error: 'timed out waiting for sign-in' }) }
          else if (popup && popup.closed && tries > 3) { clearInterval(iv); resolve({ ok: false, error: 'sign-in window closed' }) }
        }).catch(function () {})
      }, 1500)
    })
  }

  window.agentOS = {
    onAction: function (cb) {
      ensureES()
      actionL.push(cb)
      return function () { actionL = actionL.filter(function (x) { return x !== cb }) }
    },
    sendState: function (state) {
      fetch(API + '/os/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) }).catch(function () {})
    },
    onAgentSocketUrl: function (cb) {
      ensureES()
      urlL.push(cb)
      // also fetch the current URL in case it was minted before this listener attached
      getJSON('/os/agent-url').then(function (d) { if (d && d.url) cb(d.url) }).catch(function () {})
      return function () { urlL = urlL.filter(function (x) { return x !== cb }) }
    },
    registerWebview: function () {}, // no CDP/<webview> in the browser preview
    unregisterWebview: function () {},

    integrations: {
      list: function () { return getJSON('/integrations') },
      connect: function (id) {
        var popup = window.open('about:blank', 'agentos_oauth', 'width=540,height=720')
        return getJSON('/integrations/' + id + '/start', { method: 'POST' }).then(function (res) {
          if (!res || !res.authorizeUrl) {
            if (popup) popup.close()
            return { ok: false, error: (res && res.error) || 'cannot start sign-in', needsConfig: !!(res && res.needsConfig) }
          }
          if (popup) popup.location.href = res.authorizeUrl
          else window.open(res.authorizeUrl, '_blank', 'noopener')
          return pollConnected(id, popup)
        }).catch(function (e) {
          if (popup) popup.close()
          return { ok: false, error: String((e && e.message) || e) }
        })
      },
      disconnect: function (id) {
        return getJSON('/integrations/' + id + '/disconnect', { method: 'POST' }).then(function (r) { fire(integ); return r })
      },
      openExternal: function (url) { window.open(url, '_blank', 'noopener'); return Promise.resolve() },
      onUpdated: function (cb) {
        integ.push(cb)
        return function () { integ = integ.filter(function (x) { return x !== cb }) }
      }
    }
  }

  // OAuth callback tab posts this when done — refresh integration widgets promptly.
  window.addEventListener('message', function (e) {
    if (e && e.data && e.data.type === 'agentos:oauth') fire(integ)
  })

  console.info('[agent-os preview] fetch+SSE client active (surface model) — agent actions arrive over /api/os/events.')
})()
