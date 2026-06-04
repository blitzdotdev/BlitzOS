/*
 * Browser `window.agentOS` implemented over fetch (not Electron IPC).
 *
 * The real Electron preload exposes window.agentOS via contextBridge -> ipcRenderer.
 * In the browser preview there's no Electron, so this provides the SAME interface
 * backed by the standalone Node backend (preview/backend.mjs), reached through the
 * Vite proxy at `/api`. The renderer (App.tsx / ConnectPanel / IntegrationWidget)
 * is unchanged — it just calls window.agentOS.integrations.* as before.
 *
 * Injected only by vite.renderer.preview.mjs (classic head script, runs before the
 * module entry). Guards on an existing window.agentOS, so it's inert in Electron.
 */
;(function () {
  if (window.agentOS) return // real Electron preload present — never override it

  var API = '/api'
  var listeners = []
  function emit() { listeners.slice().forEach(function (cb) { try { cb() } catch (e) {} }) }
  function getJSON(path, opts) { return fetch(API + path, opts).then(function (r) { return r.json() }) }

  function poll(id, popup) {
    // Provider tab redirects to /api/oauth/callback; backend stores the token.
    // We poll the status list until this provider flips to connected.
    return new Promise(function (resolve) {
      var tries = 0
      var iv = setInterval(function () {
        tries++
        getJSON('/integrations').then(function (list) {
          var it = (list || []).find(function (x) { return x.id === id })
          if (it && it.connected) {
            clearInterval(iv); emit(); resolve({ ok: true, label: it.label })
          } else if (tries > 120) { // ~3 min
            clearInterval(iv); resolve({ ok: false, error: 'timed out waiting for sign-in' })
          } else if (popup && popup.closed && tries > 3) {
            // tab closed without connecting; give it a couple extra ticks then stop
            clearInterval(iv); resolve({ ok: false, error: 'sign-in window closed' })
          }
        }).catch(function () {})
      }, 1500)
    })
  }

  window.agentOS = {
    onOpenWindow: function () { return function () {} },
    integrations: {
      list: function () { return getJSON('/integrations') },
      connect: function (id) {
        // Open the popup synchronously (preserve the user gesture so it isn't
        // blocked), then point it at the authorize URL once the backend replies.
        var popup = window.open('about:blank', 'agentos_oauth', 'width=540,height=720')
        return getJSON('/integrations/' + id + '/start', { method: 'POST' }).then(function (res) {
          if (!res || !res.authorizeUrl) {
            if (popup) popup.close()
            return { ok: false, error: (res && res.error) || 'cannot start sign-in', needsConfig: !!(res && res.needsConfig) }
          }
          if (popup) popup.location.href = res.authorizeUrl
          else window.open(res.authorizeUrl, '_blank', 'noopener')
          return poll(id, popup)
        }).catch(function (e) {
          if (popup) popup.close()
          return { ok: false, error: String((e && e.message) || e) }
        })
      },
      disconnect: function (id) {
        return getJSON('/integrations/' + id + '/disconnect', { method: 'POST' }).then(function (r) { emit(); return r })
      },
      openExternal: function (url) { window.open(url, '_blank', 'noopener'); return Promise.resolve() },
      onUpdated: function (cb) {
        listeners.push(cb)
        return function () { listeners = listeners.filter(function (x) { return x !== cb }) }
      }
    }
  }

  // The OAuth callback tab posts this when it finishes; refresh widgets promptly.
  window.addEventListener('message', function (e) {
    if (e && e.data && e.data.type === 'agentos:oauth') emit()
  })

  console.info('[agent-os preview] fetch client active — real OAuth via /api backend (tokens stored on the preview host, not a Keychain).')
})()
