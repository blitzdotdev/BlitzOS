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

  // ---- server mode: stream WS for live web surfaces (headless browser → <canvas>) ----
  var streamWs = null
  var frameHandlers = {} // surfaceId -> draw(base64Jpeg)
  function ensureStream() {
    if (streamWs && (streamWs.readyState === 0 || streamWs.readyState === 1)) return streamWs
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    streamWs = new WebSocket(proto + '//' + location.host + '/api/os/stream')
    streamWs.onmessage = function (ev) {
      var m
      try { m = JSON.parse(ev.data) } catch (e) { return }
      if (m.t === 'frame' && frameHandlers[m.id]) frameHandlers[m.id](m.data)
    }
    streamWs.onclose = function () { streamWs = null }
    return streamWs
  }
  function streamSend(obj) {
    var ws = ensureStream()
    var s = JSON.stringify(obj)
    if (ws.readyState === 1) ws.send(s)
    else ws.addEventListener('open', function () { try { ws.send(s) } catch (e) {} }, { once: true })
  }
  function mountServerSurface(canvas, surfaceId) {
    ensureStream()
    var ctx = canvas.getContext('2d')
    var img = new Image()
    img.onload = function () {
      if (canvas.width !== img.naturalWidth) canvas.width = img.naturalWidth
      if (canvas.height !== img.naturalHeight) canvas.height = img.naturalHeight
      ctx.drawImage(img, 0, 0)
    }
    frameHandlers[surfaceId] = function (b64) { img.src = 'data:image/jpeg;base64,' + b64 }
    // map a canvas event to the page's CSS px (frame buffer is the page's CSS size at DPR 1)
    function toPage(e) {
      var r = canvas.getBoundingClientRect()
      var sx = canvas.width / (r.width || 1)
      var sy = canvas.height / (r.height || 1)
      return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy }
    }
    function cdp(method, params) { streamSend({ t: 'cdp', id: surfaceId, method: method, params: params }) }
    var onMove = function (e) { var p = toPage(e); cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }) }
    var onDown = function (e) { e.preventDefault(); e.stopPropagation(); canvas.focus(); var p = toPage(e); cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }) }
    var onUp = function (e) { var p = toPage(e); cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }) }
    // stopPropagation so scrolling a surface drives the page, not the canvas pan/zoom
    var onWheel = function (e) { e.preventDefault(); e.stopPropagation(); var p = toPage(e); cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY }) }
    var onKey = function (e) {
      e.preventDefault()
      var t = e.type === 'keydown' ? 'keyDown' : 'keyUp'
      var params = { type: t, key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, nativeVirtualKeyCode: e.keyCode }
      if (t === 'keyDown' && e.key && e.key.length === 1) params.text = e.key
      cdp('Input.dispatchKeyEvent', params)
    }
    canvas.setAttribute('tabindex', '0')
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mouseup', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('keydown', onKey)
    canvas.addEventListener('keyup', onKey)
    return function cleanup() {
      delete frameHandlers[surfaceId]
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('keydown', onKey)
      canvas.removeEventListener('keyup', onKey)
    }
  }

  window.agentOS = {
    serverMode: !!window.__BLITZ_SERVER_MODE__,
    mountServerSurface: mountServerSurface,
    serverNavigate: function (id, url) { streamSend({ t: 'cdp', id: id, method: 'Page.navigate', params: { url: url } }) },
    serverReload: function (id) { streamSend({ t: 'cdp', id: id, method: 'Page.reload', params: {} }) },

    // Multi-workspace launcher (server-mode only). list/create/switch hit the backend routes.
    // Send raw names — the server's safeName is the one validator; render its error. (The active
    // workspace name arrives via the normal onAction 'switch'/'hydrate' events, so no separate sub.)
    workspaces: {
      list: function () { return getJSON('/os/workspaces') },
      create: function (name) { return getJSON('/os/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name }) }) },
      switch: function (name) { return getJSON('/os/workspace/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name }) }) },
      thumb: function (name, dataUrl) { return getJSON('/os/workspace/thumb', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: name, dataUrl: dataUrl }) }) },
      thumbUrl: function (name, ts) { return API + '/os/workspace/thumb?name=' + encodeURIComponent(name) + (ts ? '&t=' + ts : '') }
    },

    // srcdoc widget bridge: relay a widget's data request to the backend data route
    // (consent-gated). Token stays server-side; the widget only ever sees {items}.
    widgetRequest: function (reqObj) {
      var p = '/integrations/' + encodeURIComponent(reqObj.provider) + '/' + encodeURIComponent(reqObj.resource) +
        '?surface=' + encodeURIComponent(reqObj.surfaceId)
      return fetch(API + p).then(function (r) {
        return r.json().then(function (b) {
          if (r.ok) return { ok: true, data: b }
          return { ok: false, error: (b && b.error) || 'request failed', code: b && b.code }
        })
      }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) } })
    },
    grantConsent: function (surfaceId, provider) {
      return fetch(API + '/os/consent', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surfaceId: surfaceId, provider: provider })
      }).then(function (r) { return r.json() }).catch(function () { return { ok: false } })
    },
    // Drop all consent for a surface (its widget code changed → re-approval required).
    revokeConsent: function (surfaceId) {
      return fetch(API + '/os/consent/revoke', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surfaceId: surfaceId })
      }).then(function (r) { return r.json() }).catch(function () { return { ok: false } })
    },
    // #52: group surfaces into a REAL folder on disk (mkdir + mv their files into a subdir).
    groupIntoFolder: function (name, ids, kind) {
      return fetch(API + '/os/group', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name, ids: ids, kind: kind })
      }).then(function (r) { return r.json() }).catch(function () { return { ok: false } })
    },
    // "New Folder" (files) / "New Board" (windows+widgets) — the right-click desktop action.
    newFolder: function (name, kind, x, y) {
      return fetch(API + '/os/new-folder', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name, kind: kind, x: x, y: y })
      }).then(function (r) { return r.json() }).catch(function () { return { ok: false } })
    },
    // List a normal folder's contents for the file-manager overlay (Electron uses the os:dir IPC).
    listDir: function (p) {
      return getJSON('/os/dir?path=' + encodeURIComponent(p || '')).catch(function () { return null })
    },
    // Close = delete the closed window's backing content file so it doesn't resurrect on reconcile.
    closeSurfaceFile: function (id) {
      return fetch(API + '/os/close-surface', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id })
      }).then(function (r) { return r.json() }).catch(function () { return { ok: false } })
    },
    // A sandboxed srcdoc widget fired an action back to the agent (server parity with Electron IPC).
    surfaceAction: function (payload) {
      fetch(API + '/os/surface-action', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {})
      }).catch(function () {})
    },
    // Drag-drop: the browser has no FS path, so onDrop uploads bytes (files) / recurses entries (folders)
    // via /os/upload instead. dropPaths returns [] so the renderer takes the upload branch; ingestPaths is
    // the Electron path-copy and is inert here.
    dropPaths: function () { return [] },
    ingestPaths: function () { return Promise.resolve({ ok: false }) },
    // P0 consent: let the agent read this web surface's content over the relay.
    setContentShare: function (surfaceId, on) {
      return fetch(API + '/os/content-share', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surfaceId: surfaceId, on: on })
      }).then(function (r) { return r.json() }).catch(function () { return { ok: false } })
    },
    // The user typed a message to the agent in the in-canvas Chat.
    sendMessage: function (text) {
      fetch(API + '/os/user-message', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text })
      }).catch(function () {})
    },
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
    reportWebview: function () {}, // electron-only (webview guest -> main); no-op in the browser
    onMetaTap: function () { return function () {} }, // electron-only ⌘-tap; no-op subscribe

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
