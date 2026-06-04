# BlitzOS

An agent OS desktop: an infinite canvas of live "surfaces" that you, or an AI, can open and arrange. Electron + React + TypeScript.

## Run (macOS)

```bash
cd agent-os
npm install
npm run dev
```

## Surfaces

Four kinds, created by the human (left `+`) or the agent:

- **web** — live `<webview>` of any site (Discord, Sheets, anything)
- **app** — `<iframe>` of a first-party blitz.dev app
- **srcdoc** — sandboxed iframe of HTML the agent writes inline (no backend)
- **native** — built-in widget (`note` = an editable post-it)

## Drive it with an AI

Click **Connect AI**, paste the URL into Claude / ChatGPT, and ask it to open surfaces. It runs over the [agent-socket](https://agentsocket.dev) relay, no MCP needed.

## Integrations

Sign in (OAuth SSO) to Gmail / GitHub / Slack / Jira / Discord. One-time: copy `integrations.config.example.json` → `integrations.config.json` (gitignored) and add each provider's client id + secret. Redirect URL to register everywhere: `http://127.0.0.1:8723/callback`.

See `CLAUDE.md` for architecture and `../plans/agent-os-desktop-architecture.md` for the roadmap.
