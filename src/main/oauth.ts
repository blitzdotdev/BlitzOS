import { createServer } from 'http'
import { randomBytes, createHash } from 'crypto'
import { shell } from 'electron'

// Fixed loopback redirect so every provider's OAuth app registers ONE constant
// callback URL. (Atlassian/GitHub require exact-ish redirect matching, so a
// stable port is far less fragile than a random one.)
export const REDIRECT_PORT = 8723
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`

// Only one OAuth flow can own the loopback port at a time. If a previous flow
// was abandoned (user closed the browser without finishing), cancel it so the
// port frees for the next attempt.
let activeCancel: (() => void) | null = null

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function page(msg: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:-apple-system;background:#0e1116;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>${msg}</h2></body>`
}

export interface AuthorizeResult {
  code: string
  codeVerifier?: string
}

/**
 * Run the browser half of an OAuth authorization-code flow: open the provider's
 * real sign-in in the system browser (uses the session the user is already
 * logged into), catch the redirect on a loopback server, return the code.
 */
export function loopbackAuthorize(opts: {
  authorizeUrl: string
  clientId: string
  scope: string
  scopeParam?: string
  usePkce?: boolean
  extraAuthParams?: Record<string, string>
}): Promise<AuthorizeResult> {
  // Free the port from any abandoned previous flow.
  if (activeCancel) activeCancel()

  const codeVerifier = opts.usePkce ? base64url(randomBytes(32)) : undefined
  const challenge = codeVerifier ? base64url(createHash('sha256').update(codeVerifier).digest()) : undefined
  const state = base64url(randomBytes(16))

  return new Promise<AuthorizeResult>((resolve, reject) => {
    let settled = false

    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const err = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      // Providers redirect to /callback, but accept the code on any path (Google
      // loopback desktop clients may use the bare host). Ignore noise like
      // /favicon.ico that carries neither code nor error.
      if (!err && !code) {
        res.writeHead(204)
        res.end()
        return
      }
      const reply = (msg: string): void => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(page(msg))
      }
      if (err) {
        reply('Sign-in failed. You can close this tab.')
        finish(() => reject(new Error(err)))
        return
      }
      if (url.searchParams.get('state') !== state) {
        reply('State mismatch. You can close this tab.')
        finish(() => reject(new Error('state mismatch')))
        return
      }
      if (!code) {
        res.writeHead(400)
        res.end()
        return
      }
      reply('Connected. You can close this tab and return to Agent OS.')
      finish(() => resolve({ code, codeVerifier }))
    })

    const timeout = setTimeout(() => finish(() => reject(new Error('Sign-in timed out'))), 3 * 60 * 1000)

    function finish(action: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (activeCancel === cancel) activeCancel = null
      try {
        server.close()
      } catch {
        // ignore
      }
      action()
    }

    function cancel(): void {
      finish(() => reject(new Error('cancelled')))
    }

    activeCancel = cancel

    let portRetries = 0
    function listen(): void {
      server.listen(REDIRECT_PORT, '127.0.0.1')
    }

    server.on('error', (e: NodeJS.ErrnoException) => {
      // The port may briefly linger after a just-cancelled flow; retry a few times.
      if (e.code === 'EADDRINUSE' && portRetries < 12 && !settled) {
        portRetries += 1
        setTimeout(listen, 150)
        return
      }
      finish(() => reject(new Error(e.code === 'EADDRINUSE' ? `Loopback port ${REDIRECT_PORT} is busy` : String(e))))
    })

    server.on('listening', () => {
      const u = new URL(opts.authorizeUrl)
      u.searchParams.set('client_id', opts.clientId)
      u.searchParams.set('redirect_uri', REDIRECT_URI)
      u.searchParams.set('response_type', 'code')
      u.searchParams.set(opts.scopeParam ?? 'scope', opts.scope)
      u.searchParams.set('state', state)
      if (challenge) {
        u.searchParams.set('code_challenge', challenge)
        u.searchParams.set('code_challenge_method', 'S256')
      }
      for (const [k, v] of Object.entries(opts.extraAuthParams ?? {})) u.searchParams.set(k, v)
      shell.openExternal(u.toString())
    })

    listen()
  })
}
