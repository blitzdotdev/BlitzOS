# BlitzOS

**Your agents in one place.**

BlitzOS brings the agents you already use, like Claude and Codex, into one place and connects them to your apps so they can work across them. It's a free, open source Mac app that lives in your notch: a quiet pill that unfurls into a full agent chat the moment you need it.

This repo is the source for that app. The easiest way to get BlitzOS is to download it from [blitzos.com](https://blitzos.com) (free, in beta), or build it from source below.

## What it does

- **Lives in your notch** and shows live progress as your agent works.
- **Runs many agents at once**, each its own thread, in parallel.
- **Connects to your apps** through the browser you're already signed into. No tokens, no setup.
- **Handles big jobs** with blitzscript, a small workflow layer that fans a job out across many agents and tracks them live on a kanban board.

## Under the hood

- **Bring your own agent.** BlitzOS supplies the loop; your agent supplies the intelligence. Claude Code is supported in the beta today, with Pi and Codex coming.
- **Open transport.** Agents drive BlitzOS over [agent-socket](https://agentsocket.dev): a plain HTTP/JSON transport, not MCP, that we're building as an open standard so any agent can connect.

## Build from source

BlitzOS is a macOS app for Apple Silicon. You'll need:

- macOS on Apple Silicon (arm64)
- Node 20+ (`.nvmrc` pins 20)
- Xcode command-line tools: `xcode-select --install` (for the native helpers)
- Claude Code (`claude`) on your `PATH` — the agent you bring to the island

Then:

```bash
npm install
npm run dev      # run it in development
npm run dist     # package BlitzOS.app into release/
```

`npm run dist` produces a signed, notarized build when Apple credentials are set, and an ad-hoc-signed local build otherwise.

## License

[Apache 2.0](LICENSE). The BlitzOS name and logo are trademarks and aren't covered by that license.
