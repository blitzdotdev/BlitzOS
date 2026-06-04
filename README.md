# Agent OS (prototype)

Electron Mac desktop: an infinite-canvas spatial desktop. This is **prototype slice 1: canvas + live windows**. See `../plans/agent-os-desktop-architecture.md` for the full plan and backlog.

## Run

```bash
cd agent-os
npm install
npm run dev
```

(`npm install` downloads the Electron binary, ~150 MB the first time.)

## What works

**Canvas**
- Infinite canvas: **drag empty space to pan**, **pinch / ctrl-scroll to zoom** about the cursor.
- **Window plane**: **+ Window** opens a live `<webview>`. Drag the title bar to move; click to raise; × to close. Off-screen windows stay alive (`backgroundThrottling: false`).
- **Primary space**: the dashed rectangle at the origin. **Primary** button or **⌘0** zooms-to-fit there.
- No taskbar (by design, for now).

**Integrations — OAuth SSO, tokens encrypted in your macOS Keychain (`safeStorage`)**
- One widget per app: **Gmail, GitHub, Slack, Jira, Discord**. Greyed = disconnected; green dot = connected (shows the account).
- Click **Sign in with X** → your system browser opens the provider's real sign-in (using the session you're already logged into) → hit **Allow** → it redirects back to `http://127.0.0.1:8723/callback` and you're connected. Nothing to type or paste.
- Under the hood: loopback authorization-code flow (PKCE where supported), tokens exchanged server-side in the Electron main process and stored encrypted.
- **Disconnect** removes the stored credential.

### One-time setup (per provider you want to use)

OAuth "Sign in with X" only exists if there's a registered OAuth app behind it. Copy `integrations.config.example.json` to `integrations.config.json` (gitignored) and add each provider's **client id + secret**. Every provider registers the **same** callback/redirect URL:

```
http://127.0.0.1:8723/callback
```

- **Gmail** — https://console.cloud.google.com/apis/credentials (OAuth client; add the redirect + add your email as a Test user)
- **GitHub** — https://github.com/settings/developers (New OAuth App; Authorization callback URL = the redirect)
- **Slack** — https://api.slack.com/apps (User Token Scopes + redirect; note Slack may require an https redirect — flagged)
- **Jira** — https://developer.atlassian.com/console/myapps (OAuth 2.0 3LO; Jira scopes + callback)
- **Discord** — https://discord.com/developers/applications (OAuth2 redirect; connects your account, a support bot token is a separate step)

> Roadmap: this one-time registration is slated to be **automated via computer-use skills** that drive each provider's site and provision the OAuth app for you, so even this becomes zero-touch (see `../plans/agent-os-desktop-architecture.md`).

## Control API (agent → OS)

A localhost HTTP server (NOT MCP) prints its URL + bearer token to the console on launch:

```
[agent-os] control API: http://127.0.0.1:<port>  token=<token>
```

Slice 1 exposes just enough to prove the path:

```bash
curl -s -X POST http://127.0.0.1:<port>/windows \
  -H "authorization: Bearer <token>" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com","title":"opened by agent"}'
```

The agent can also **drive what's inside a live window** via CDP (click / type / eval / screenshot):

```bash
# read the page title
curl -s -X POST http://127.0.0.1:<port>/windows/<id>/control \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"action":"eval","expression":"document.title"}'

# type into a field (clicks the selector to focus it first)
curl -s -X POST http://127.0.0.1:<port>/windows/<id>/control \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"action":"type","selector":"input[name=q]","text":"hello"}'
```

The full control surface, the headless Claude Code / Codex runner, and the rest of the integrations/auth layer are in the backlog.

## Stack

electron-vite + React + TypeScript + zustand. `webviewTag` is enabled and `backgroundThrottling` is forced off for all guests so off-screen windows stay alive.
