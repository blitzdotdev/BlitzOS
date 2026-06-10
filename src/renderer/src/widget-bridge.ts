// The OS<->widget bridge, shared by the renderer (parent side, in SurfaceFrame) and
// injected into every `srcdoc` widget (the `window.blitz` shim below).
//
// A widget is a sandboxed iframe (`sandbox="allow-scripts"`, no same-origin, no
// network). Its ONLY channel to the OS — and through the OS to the user's connected
// integrations — is postMessage. The renderer prepends BRIDGE_SHIM to every widget's
// srcDoc so `window.blitz` is always present; the widget's own (forkable) html never
// contains the shim. Keep this in sync with widget-catalog.mjs's WIDGET_AUTHORING_MD.
//
// Wire protocol (widget <-> parent):
//   widget -> parent  { type:'blitz:hello' }                                  (I'm alive)
//   parent -> widget  { type:'blitz:init',  props }                           (seed/rehydrate)
//   parent -> widget  { type:'blitz:props', props }                           (live prop change, no reload)
//   widget -> parent  { type:'blitz:req',   reqId, op:'data', provider, resource }
//   parent -> widget  { type:'blitz:res',   reqId, ok, data? , error? }
//
// The parent authenticates the sender by object identity (event.source ===
// iframe.contentWindow) — NOT event.origin, which is the literal string "null" for a
// sandboxed srcdoc and is forgeable. reqId is namespaced per-surface by that identity.

/** Injected (prepended to srcDoc) so `window.blitz` exists in every widget. */
export const BRIDGE_SHIM = `<script>
(function () {
  if (window.blitz) return;
  // Per-document instance nonce: a reqId from one widget generation can never
  // collide with another's after an html reload (the parent also checks the
  // issuing window, so a stale reply can't be cross-delivered).
  var inst = Math.random().toString(36).slice(2);
  var seq = 0, pending = {}, props = {}, ready = false, queue = [], readyCbs = [], propCbs = [], lastFired = null;
  function post(m) { try { window.parent.postMessage(m, '*'); } catch (e) {} }
  function flush() { var q = queue; queue = []; for (var i = 0; i < q.length; i++) q[i](); }
  // onProps fires on CHANGE, not on every delivery: the OS re-posts props whenever a surface's props
  // identity changes (e.g. a workspace-folder reconcile rebuilds the descriptor with identical content),
  // which would otherwise re-run every widget's render() and replay its entrance animation each time.
  // Dedupe by value so a no-op re-delivery is silent.
  function firePropCbs() {
    // Don't dedupe-poison before any onProps is registered. A blitz:props posted while the iframe is
    // still loading (bridge listener up, but the widget hasn't called onProps yet) would otherwise set
    // lastFired with NOTHING to fire — then the blitz:init on load carrying the same props is deduped
    // away and the (now-registered) callback never fires: the widget renders its spawn state forever
    // (the "spawned-then-driven dossier stays blank" bug). No callbacks = nothing to remember.
    if (!propCbs.length) return;
    var sig; try { sig = JSON.stringify(props); } catch (e) { sig = null; }
    if (sig !== null && sig === lastFired) return;
    lastFired = sig;
    for (var i = 0; i < propCbs.length; i++) try { propCbs[i](props); } catch (x) {}
  }
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;            // only the OS parent
    var m = e.data; if (!m || typeof m !== 'object') return;
    if (m.type === 'blitz:init') {
      props = m.props || {};
      if (!ready) { ready = true; flush(); for (var i = 0; i < readyCbs.length; i++) try { readyCbs[i](props); } catch (x) {} }
      firePropCbs();
    } else if (m.type === 'blitz:props') {
      props = Object.assign({}, props, m.props || {});
      firePropCbs();
    } else if (m.type === 'blitz:res' && m.reqId && pending[m.reqId]) {
      var p = pending[m.reqId]; delete pending[m.reqId];
      if (m.ok) p.resolve(m.data); else p.reject(new Error(m.error || 'request failed'));
    }
  });
  function request(op, payload) {
    return new Promise(function (resolve, reject) {
      var reqId = inst + '-' + (++seq);
      pending[reqId] = { resolve: resolve, reject: reject };
      var send = function () { post(Object.assign({ type: 'blitz:req', reqId: reqId, op: op }, payload)); };
      if (ready) send(); else queue.push(send);
    });
  }
  window.blitz = {
    data: function (provider, resource) { return request('data', { provider: provider, resource: resource }); },
    tool: function (tool, args) { return request('tool', { tool: tool, args: args || {} }); },
    sendMessage: function (text, sessionId) { return request('msg', { text: String(text == null ? '' : text), sessionId: sessionId == null ? undefined : String(sessionId) }); },
    chat: function (op, args) { return request('chat', { chatOp: String(op || ''), args: args || {} }); },
    listDir: function (path) { return request('listdir', { path: String(path == null ? '' : path) }); },
    setProps: function (patch) { return request('setprops', { patch: patch || {} }); },
    props: function () { return props; },
    onProps: function (cb) { propCbs.push(cb); if (ready) try { cb(props); } catch (x) {} },
    ready: function (cb) { if (ready) { try { cb(props); } catch (x) {} } else readyCbs.push(cb); }
  };
  post({ type: 'blitz:hello' });   // the parent also pushes init on iframe load
})();
</script>
`
