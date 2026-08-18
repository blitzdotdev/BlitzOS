<h1 align="center">BlitzOS</h1>

<p align="center"><strong>Open platform for running agents.</strong></p>

<p align="center">
  One place for teams to run agents. Give everyone a cloud agent with scoped credentials, tools, and data. 
</p>

<p align="center">
  <a href="#capabilities">Capabilities</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#packages">Packages</a>
</p>

## Capabilities

- **Cloud agent workspaces.** Give agents a complete Linux work environment, deployed on your cloud 
- **Scoped agent workspaces.** Scope the workspace to hold only the credentials and data the work requires.
- **Multiplayer** Setup agent workspaces with custom credentials, harness, data and share with teammates
- **BYO agent.** Run Claude Code, Codex, or any other harness
- **Start from Slack** Launch agent runs in Slack and continue from browser webUI 
- **Browser webUI** Create, watch, and steer agents in workspaces via chat/terminal. View files and live port previews
- **Programmable agent workspaces** Agents can provision agent workspaces for their subagents via API. 
- **Build internal tools.** Agents can build internal dashboards, pipelines, CRMs, and tools via API, hosted on Cloudflare

## Architecture

```text
                      you · your team · apps
                               |
                      browser · terminal · API
                               |
                 +-------------+-------------+
                 |     BlitzOS control plane |
                 | workspaces · sessions · access |
                 +--------+------------+-----+
                          |            |
                     VmProvider   credential plane
                   +------+-----+ mint · proxy · broker
                   |            |       |
              cloud VM   Firecracker    integrations
                   |        host         |
                   +------+--+-----------+
                          |
                 +--------+---------+
                 |  agent workspace |
                 |  Linux · Docker   |
                 |  tools · data     |
                 |  scoped credentials|
                 |  Claude · Codex   |
                 +------------------+
```

## Packages

- [`box`](packages/box/README.md) — the complete workspace runtime: SSH, Docker, agent harnesses, terminal, chat, files, and previews.
- [`control-plane`](packages/control-plane/README.md) — workspace lifecycle, sessions, access, credential injection, volumes, and compute providers.
- [`microvm-host`](packages/microvm-host/README.md) — the Go host agent that runs and networks Firecracker workspaces.
- [`webApp`](packages/webapp/README.md) — the browser webApp for creating, configuring, sharing, and working inside workspaces.
- [`broker`](packages/broker/README.md) — short-lived Claude and Codex credential delivery for workspace fleets.
- [`schema`](packages/schema/README.md) — shared wire types and ACP conformance fixtures.

Apache-2.0.
