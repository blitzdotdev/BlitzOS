import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomUUID, randomBytes } from 'crypto'
import type { ControlAction, ControlResult } from './cdp'

export interface OpenWindowPayload {
  id: string
  url: string
  x?: number
  y?: number
  w?: number
  h?: number
  title?: string
}

interface ControlHandlers {
  openWindow: (payload: OpenWindowPayload) => void
  /** Drive a live <webview> window via CDP (click / type / eval / screenshot). */
  controlWindow: (id: string, action: ControlAction) => Promise<ControlResult>
}

/**
 * Minimal localhost control API (NOT MCP, per product decision).
 * Slice 1 ships just enough to prove the agent -> OS path:
 *   POST /windows               { url, x?, y?, w?, h?, title? }  -> opens a live window
 *   POST /windows/:id/control   { action, ... }                 -> CDP into the webview
 *   GET  /state                                                 -> placeholder ack
 * Bound to 127.0.0.1 on an ephemeral port, guarded by a per-session bearer token.
 * The full schema + auth + agent loop is slice 2 (see architecture doc backlog).
 */
export function startControlServer(handlers: ControlHandlers): void {
  const token = randomBytes(24).toString('hex')

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers['authorization']
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    // POST /windows/:id/control  { action:'click'|'type'|'eval'|'screenshot', ... }
    // Drives the live webview via CDP. Returns { ok, result? } | { ok:false, error }.
    const controlMatch = req.method === 'POST' && req.url ? /^\/windows\/([^/]+)\/control$/.exec(req.url) : null
    if (controlMatch) {
      const id = decodeURIComponent(controlMatch[1])
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 1_000_000) req.destroy() // guard
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
        const result = await handlers.controlWindow(id, action)
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      })
      return
    }

    if (req.method === 'GET' && req.url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, note: 'full state lands in slice 2' }))
      return
    }

    if (req.method === 'POST' && req.url === '/windows') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 1_000_000) req.destroy() // guard
      })
      req.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {}
          if (!parsed.url || typeof parsed.url !== 'string') {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'url required' }))
            return
          }
          const payload: OpenWindowPayload = { id: randomUUID(), ...parsed }
          handlers.openWindow(payload)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ id: payload.id }))
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid json' }))
        }
      })
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  // Port 0 -> OS picks a free ephemeral port.
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    // The headless agent reads these to call the control API.
    // eslint-disable-next-line no-console
    console.log(`[agent-os] control API: http://127.0.0.1:${port}  token=${token}`)
  })
}
