import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { osOpenWindow, osCreateSurface, osGetState, type SurfaceDescriptor } from './osActions'

/**
 * Minimal localhost control API (the LOCAL agent path; agent-socket is the
 * remote/pasted-URL path). Both drive the same osActions.
 *   POST /windows { url, x?, y?, w?, h?, title? }  -> opens a window
 *   GET  /state                                    -> current desktop state
 * Bound to 127.0.0.1 on an ephemeral port, guarded by a per-session bearer token.
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

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    console.log(`[agent-os] local control API: http://127.0.0.1:${port}  token=${token}`)
  })
}
