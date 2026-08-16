<h1 align="center">BlitzOS</h1>

<p align="center"><strong>Collaborative platform for running agents.</strong></p>

<p align="center">
  One place for teams to run agents. Agents run in linux workspaces with scoped credentials, tools, and data. Create and share agent workspaces with teammates. 
</p>

<p align="center">
  <a href="#capabilities">Capabilities</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#packages">Packages</a>
</p>

## Capabilities

- **Run persistent agent workspaces.** Launch a complete Linux environment on your cloud
- **Scoped agent workspaces.** Scope the workspace to hold only the credentials and data the work requires.
- **Browser webUI** Create, watch, and steer agents in workspaces via chat/terminal. View files and live port previews
- **BYO agent.** Run Claude Code, Codex, or any other harness  
- **Multiplayer** Invite teammates to view, edit, or resume agent sessions in a workspace, like Google Docs. 
- **Agent session persistence.** Sessions are stored with the workspace, so agents keep working through disconnects and you can resume later from any device.
- **Programmable agent workspaces** Agents can provision agent workspaces for their subagents via API. 
- **Build and automate.** Use agents for quick tasks or build internal dashboards, pipelines, CRMs, and tools

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
