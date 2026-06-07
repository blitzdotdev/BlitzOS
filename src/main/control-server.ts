import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { osOpenWindow, osCreateSurface, osGetState, osControlSurface, type SurfaceDescriptor } from './osActions'
import type { ControlAction } from './cdp'
import { waitForEvents, latestSeq, EVENTS_REMINDER } from './events'
import { setLocal } from './sessionFile'

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

    if (req.method === 'GET' && req.url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(osGetState()))
      return
    }

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

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    setLocal(`http://127.0.0.1:${port}`, token)
    console.log(`[agent-os] local control API: http://127.0.0.1:${port}  token=${token}`)
  })
}
