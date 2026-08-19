<h1 align="center">BlitzOS</h1>

<p align="center"><strong>Multiplayer AI platform</strong></p>

<p align="center">
  Create agent workspaces with custom credentials, tools, and data and share with your teammate. 
</p>

<p align="center">
  <a href="#capabilities">Capabilities</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#packages">Packages</a>
</p>

<p align="center">
  <img src="docs/images/workspace.png" alt="A BlitzOS workspace: agent terminal, chat, files, and connections in the browser" width="100%">
</p>

## Capabilities

- **Agent workspaces.** Scoped workspaces holding only the credentials and data the agent needs. 
- **Connections.** Connect GitHub, Slack, and the rest once at the org level. Agents get short-lived, scoped credentials — and must request approval before reaching anything new.
- **Multiplayer** Share agent workspaces with teammates to share work context
- **Set it up once, hand it over.** Build a custom workspace template for a role, then share it with the team.
- **BYO agent.** Run Claude Code, Codex, or any other harness
- **Start in Slack, finish in the browser.** Launch agents from chat and pick it up in the webApp 
- **webApp** Create, watch, and steer agents in workspaces via chat/terminal. View files and live port previews
- **Programmable.** Agents provision workspaces for their own subagents through the API.
- **Shared Drive.** Upload files/folders and share it with teammates and attach folders to the agent workspace
- **Shared apps.** Agents ship dashboards, CRMs, and pipelines as deployed apps with a database, auth, and a URL on Cloudflare.

## Architecture

```text
             you  ·  your teammates  ·  your agents
                                │
                  browser  ·  terminal  ·  API
                                │
        ┌───────────────────────┴───────────────────────┐
        │             BlitzOS control plane             │
        │     workspaces · sessions · access · org      │
        └───────────┬───────────────────────┬───────────┘
                    │                       │
               VmProvider           credential plane
                    │                       │
         cloud VM · Firecracker   mint · proxy · broker
                    │                       │
                    │                 integrations
                    │                       │
        ┌───────────┴───────────────────────┴───────────┐
        │                agent workspace                │
        │            Linux · Docker · tools             │
        │        your data · scoped credentials         │
        │              Claude · Codex · …               │
        └───────────────────────────────────────────────┘
```

The control plane owns workspace lifecycle, sessions, and org access. It resolves
compute through a `VmProvider` — a cloud VM or a Firecracker host you run yourself —
and injects short-lived credentials through the credential plane. The agent never
holds a long-lived secret.

## Packages

- [`box`](packages/box/README.md) — the complete workspace runtime: SSH, Docker, agent harnesses, terminal, chat, files, and previews.
- [`control-plane`](packages/control-plane/README.md) — workspace lifecycle, sessions, access, credential injection, volumes, and compute providers.
- [`microvm-host`](packages/microvm-host/README.md) — the Go host agent that runs and networks Firecracker workspaces.
- [`webApp`](packages/webapp/README.md) — the browser webApp for creating, configuring, sharing, and working inside workspaces.
- [`broker`](packages/broker/README.md) — short-lived Claude and Codex credential delivery for workspace fleets.
- [`schema`](packages/schema/README.md) — shared wire types and ACP conformance fixtures.

Apache-2.0.
