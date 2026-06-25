import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { osOpenWindow, osCreateSurface, osGetState, osControlSurface, osBroadcast, type SurfaceDescriptor } from './osActions'
import { OS_TOOLS_BY_PATH } from './electron-os-tools'
import type { ControlAction } from './cdp'
import { waitForEvents, latestSeq, EVENTS_REMINDER } from './events'
import { setLocal } from './sessionFile'
import { attachIslandWebSocket } from './island-bridge.mjs'

/**
 * Minimal localhost control API (the LOCAL agent path; agent-socket is the
 * remote/pasted-URL path). Both drive the same osActions.
 *   POST /windows { url, x?, y?, w?, h?, title? }       -> opens a window
 *   POST /surface { kind, ... }                         -> creates any surface
 *   POST /surfaces/:id/control { action, ... }          -> act inside a web surface (CDP)
 *   GET  /state                                         -> current desktop state
 * Bound to 127.0.0.1 on an ephemeral port, guarded by a per-session bearer token.
 * This path is trusted (loopback + bearer), so it allows the raw `eval` action;
 * the agent-socket relay path does NOT (see agentSocket.ts).
 */
export function startControlServer(): void {
  const token = randomBytes(24).toString('hex')

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.headers['authorization'] !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    // Dev-only: replay the cinematic intro animation without restarting or wiping TCC permissions.
    if (req.method === 'POST' && req.url === '/replay-cinematic') {
      osBroadcast({ type: 'cinematic' })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === 'GET' && req.url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(osGetState()))
      return
    }

    // NOTE: /group is dispatched below by the GENERIC shared-registry handler (OS_TOOLS_BY_PATH) with
    // transport:'localhost' — no per-path alias here. The old hand-written aliases had drifted (the /group
    // alias dropped x/y that the shared handler forwards); deleting them keeps the localhost path from
    // rotting behind the relay, which is the whole point of the shared os-tools.mjs.

    // POST /surfaces/:id/control (also /windows/:id/control) — act inside a web surface.
    const ctl = req.method === 'POST' && req.url ? /^\/(?:surfaces?|windows)\/([^/]+)\/control$/.exec(req.url) : null
    if (ctl) {
      const id = decodeURIComponent(ctl[1])
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 2_000_000) req.destroy()
      })
      req.on('end', async () => {
        let action: ControlAction
        try {
          action = (body ? JSON.parse(body) : {}) as ControlAction
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }))
          return
        }
        const result = await osControlSurface(id, action)
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      })
      return
    }

    if (req.method === 'POST' && (req.url === '/windows' || req.url === '/surface')) {
      const route = req.url
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 2_000_000) req.destroy()
      })
      req.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {}
          if (route === '/windows') {
            if (!parsed.url || typeof parsed.url !== 'string') {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 'url required' }))
              return
            }
            const id = osOpenWindow(parsed)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ id }))
            return
          }
          // /surface — any kind
          if (!parsed.kind) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'kind required' }))
            return
          }
          const id = osCreateSurface(parsed as SurfaceDescriptor)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ id }))
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid json' }))
        }
      })
      return
    }

    // POST /events { since?, wait? } -> the user's activity as coalesced "moments"
    // (framed snapshots, batched ~15s, flushed on navigation/idle). Local + reliable.
    if (req.method === 'POST' && req.url === '/events') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 100_000) req.destroy()
      })
      req.on('end', async () => {
        let p: { since?: number; wait?: number } = {}
        try {
          p = body ? JSON.parse(body) : {}
        } catch {
          /* default */
        }
        const since = Number(p.since) || 0
        const wait = Math.min(Math.max(Number(p.wait) || 0, 0), 25)
        const events = await waitForEvents(since, wait * 1000)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ events, latest: latestSeq(), reminder: EVENTS_REMINDER }))
      })
      return
    }

    // Generic dispatch for every SHARED tool (os-tools.mjs) by its canonical path — this is what makes the
    // localhost path serve the FULL agent tool surface (list_state, create_surface, read_window, say,
    // list/create/switch_workspace, new_app, …) instead of the old stale subset that 404'd. Trusted
    // transport: eval allowed, DOM reads + moments unredacted. The legacy aliases above (/state, /windows,
    // /surface, /group, /events, /surfaces/:id/control) are kept for back-compat (caught first).
    const toolPath = req.url ? req.url.split('?')[0] : ''
    const tool = req.method === 'POST' ? OS_TOOLS_BY_PATH[toolPath] : undefined
    if (tool) {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 2_000_000) req.destroy()
      })
      req.on('end', async () => {
        try {
          const out = (await tool.handler({ body, transport: 'localhost' })) as Record<string, unknown> | null
          if (out && typeof out === 'object' && typeof out.status === 'number' && 'body' in out) {
            res.writeHead(out.status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(out.body))
          } else {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(out))
          }
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
        }
      })
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  // Mount the native dynamic-island WS (BlitzIsland.app connects to ws://127.0.0.1:<port>/island?token=…;
  // the SAME bearer token as the HTTP control API, which the island reads from session.json local.token via
  // setLocal below). Armed BEFORE listen so the handler is ready before the port can accept the island's
  // first connect (it reconnects with backoff regardless). Electron-free + tested in
  // scripts/test-island-bridge.mjs (plans/blitzos-dynamic-island.md).
  attachIslandWebSocket(server, token)

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    setLocal(`http://127.0.0.1:${port}`, token)
    console.log(`[agent-os] local control API: http://127.0.0.1:${port}  token=${token}`)
  })
}
