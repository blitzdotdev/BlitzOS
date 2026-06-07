import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { loadRecord, saveRecord, deleteRecord } from './tokenStore'
import { loopbackAuthorize, REDIRECT_URI } from './oauth'
import { capturedScopes } from './provider-specs.mjs'

interface Def {
  id: string
  name: string
  color: string
  /** true when this provider's per-user data is real user SSO; false = caveat (see helpText). */
  helpUrl: string
  helpText: string
}

const REGISTRY: Def[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    color: '#EA4335',
    helpUrl: 'https://console.cloud.google.com/apis/credentials',
    helpText:
      'One-time: create an OAuth client (type "Desktop app" or "Web") with redirect ' +
      REDIRECT_URI +
      ', add your email as a Test user, and paste its client id + secret into integrations.config.json.'
  },
  {
    id: 'github',
    name: 'GitHub',
    color: '#6e7681',
    helpUrl: 'https://github.com/settings/developers',
    helpText:
      'One-time: create an OAuth App with callback ' +
      REDIRECT_URI +
      ', then paste its Client ID + a generated Client Secret into integrations.config.json.'
  },
  {
    id: 'slack',
    name: 'Slack',
    color: '#4A154B',
    helpUrl: 'https://api.slack.com/apps',
    helpText:
      'One-time: create an app, add User Token Scopes (channels:history, users:read), set the redirect ' +
      REDIRECT_URI +
      ', and paste client id + secret into integrations.config.json. (Slack may require an https redirect; flagged.)'
  },
  {
    id: 'jira',
    name: 'Jira',
    color: '#0052CC',
    helpUrl: 'https://developer.atlassian.com/console/myapps/',
    helpText:
      'One-time: create an OAuth 2.0 (3LO) app, add Jira scopes + a callback ' +
      REDIRECT_URI +
      ', and paste client id + secret into integrations.config.json.'
  },
  {
    id: 'discord',
    name: 'Discord',
    color: '#5865F2',
    helpUrl: 'https://discord.com/developers/applications',
    helpText:
      'One-time: create an app, add redirect ' +
      REDIRECT_URI +
      ', paste client id + secret. (This connects your Discord account via SSO; a support bot token is a separate step.)'
  }
]

function defFor(id: string): Def {
  const d = REGISTRY.find((r) => r.id === id)
  if (!d) throw new Error(`unknown provider ${id}`)
  return d
}

// ---------- config (per-provider OAuth client id + secret) ----------

type ProviderCreds = { clientId?: string; clientSecret?: string }
type AppConfig = Record<string, ProviderCreds>

function loadConfig(): AppConfig {
  const candidates = [
    join(process.cwd(), 'integrations.config.json'),
    join(app.getAppPath(), 'integrations.config.json')
  ]
  for (const p of candidates) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as AppConfig
    } catch {
      // ignore malformed config
    }
  }
  return {}
}

function credsFor(id: string): ProviderCreds {
  return loadConfig()[id] ?? {}
}

function publicEntry(d: Def): Record<string, unknown> {
  const rec = loadRecord(d.id)
  const creds = credsFor(d.id)
  return {
    id: d.id,
    name: d.name,
    color: d.color,
    helpUrl: d.helpUrl,
    helpText: d.helpText,
    connected: !!rec,
    label: rec?.label ?? null,
    configured: !!(creds.clientId && creds.clientSecret)
  }
}

/** Public status of every integration (for the list_integrations agent tool). */
export function integrationStatuses(): Record<string, unknown>[] {
  return REGISTRY.map(publicEntry)
}

/** The ids of integrations that are currently connected (have a stored token). */
export function connectedProviders(): string[] {
  return REGISTRY.filter((d) => !!loadRecord(d.id)).map((d) => d.id)
}

// ---------- token exchange helpers ----------

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body)
  })
  return (await r.json()) as Record<string, unknown>
}

async function postJson(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body)
  })
  return (await r.json()) as Record<string, unknown>
}

async function getJson(url: string, token: string): Promise<Record<string, unknown>> {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } })
  return (await r.json()) as Record<string, unknown>
}

// ---------- per-provider OAuth SSO flows ----------

async function connectProvider(id: string): Promise<{ label: string; secrets: Record<string, unknown> }> {
  const { clientId, clientSecret } = credsFor(id)
  if (!clientId || !clientSecret) throw new Error('not configured')

  if (id === 'gmail') {
    const { code, codeVerifier } = await loopbackAuthorize({
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      clientId,
      scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
      usePkce: true,
      extraAuthParams: { access_type: 'offline', prompt: 'consent' }
    })
    const tok = await postForm('https://oauth2.googleapis.com/token', {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier as string
    })
    if (!tok.access_token) throw new Error(String(tok.error_description || tok.error || 'token exchange failed'))
    const me = await getJson('https://openidconnect.googleapis.com/v1/userinfo', tok.access_token as string)
    return { label: (me.email as string) || 'google account', secrets: tok }
  }

  if (id === 'github') {
    const { code, codeVerifier } = await loopbackAuthorize({
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      clientId,
      scope: 'read:user repo',
      usePkce: true
    })
    const tok = await postForm('https://github.com/login/oauth/access_token', {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier as string
    })
    if (!tok.access_token) throw new Error(String(tok.error_description || tok.error || 'token exchange failed'))
    const me = await getJson('https://api.github.com/user', tok.access_token as string)
    return { label: (me.login as string) || 'github user', secrets: tok }
  }

  if (id === 'slack') {
    const { code } = await loopbackAuthorize({
      authorizeUrl: 'https://slack.com/oauth/v2/authorize',
      clientId,
      scope: 'channels:history,groups:history,users:read',
      scopeParam: 'user_scope'
    })
    const tok = await postForm('https://slack.com/api/oauth.v2.access', {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: REDIRECT_URI
    })
    if (!tok.ok) throw new Error(`Slack: ${String(tok.error || 'oauth failed')}`)
    const authed = (tok.authed_user as Record<string, unknown>) || {}
    const userToken = authed.access_token as string | undefined
    if (!userToken) throw new Error('Slack returned no user token')
    const team = (tok.team as Record<string, unknown>) || {}
    return { label: `${String(authed.id || 'user')} @ ${String(team.name || 'workspace')}`, secrets: tok }
  }

  if (id === 'jira') {
    const { code } = await loopbackAuthorize({
      authorizeUrl: 'https://auth.atlassian.com/authorize',
      clientId,
      scope: 'read:jira-work read:jira-user offline_access',
      extraAuthParams: { audience: 'api.atlassian.com', prompt: 'consent' }
    })
    const tok = await postJson('https://auth.atlassian.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: REDIRECT_URI
    })
    if (!tok.access_token) throw new Error(String(tok.error_description || tok.error || 'token exchange failed'))
    const resources = (await (
      await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
        headers: { authorization: `Bearer ${tok.access_token as string}`, accept: 'application/json' }
      })
    ).json()) as { id: string; name: string; url: string }[]
    const site = resources?.[0]
    return {
      label: site?.name || 'jira site',
      secrets: { ...tok, cloudId: site?.id, siteUrl: site?.url }
    }
  }

  if (id === 'discord') {
    const { code } = await loopbackAuthorize({
      authorizeUrl: 'https://discord.com/oauth2/authorize',
      clientId,
      scope: 'identify guilds'
    })
    const tok = await postForm('https://discord.com/api/oauth2/token', {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI
    })
    if (!tok.access_token) throw new Error(String(tok.error_description || tok.error || 'token exchange failed'))
    const me = await getJson('https://discord.com/api/v10/users/@me', tok.access_token as string)
    return { label: (me.username as string) || 'discord user', secrets: tok }
  }

  throw new Error(`no flow for ${id}`)
}

// ---------- IPC ----------

export function registerIntegrations(getWindow: () => BrowserWindow | null): void {
  const emitUpdated = (): void => getWindow()?.webContents.send('integrations:updated')

  ipcMain.handle('integrations:list', () => REGISTRY.map(publicEntry))

  ipcMain.handle('integrations:connect', async (_e, id: string) => {
    const def = defFor(id)
    const creds = credsFor(id)
    if (!creds.clientId || !creds.clientSecret) {
      return { ok: false, needsConfig: true, error: `Add ${def.id}.clientId and ${def.id}.clientSecret to integrations.config.json` }
    }
    try {
      const { label, secrets } = await connectProvider(id)
      saveRecord({ provider: id, label, secrets, grantedScopes: capturedScopes(secrets), connectedAt: Date.now() })
      emitUpdated()
      return { ok: true, label }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('integrations:disconnect', (_e, id: string) => {
    deleteRecord(id)
    emitUpdated()
    return { ok: true }
  })

  ipcMain.handle('integrations:openExternal', (_e, url: string) => {
    shell.openExternal(url)
  })
}
