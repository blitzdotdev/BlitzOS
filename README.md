<h1 align="center">BlitzOS</h1>

<p align="center"><strong>AI workspace for teams. Create and share fully configured AI work environments</strong></p>

<p align="center">
  <a href="#what-you-can-do-with-blitzos">What you can do</a> •
  <a href="#installation">Installation</a> •
  <a href="#packages">Packages</a>
</p>

<p align="center">
  <img src="docs/images/workspace.png" alt="A BlitzOS workspace: the session rail with worktrees and chats on the left, an agent session in the middle, and its diff on the right" width="100%">
</p>

## What you can do with BlitzOS

### Let teammates use agents without setup

Teammates can just use agents instead of learning how to use them. Invite teammates to a workspace, and they get a cloud computer with the agent installed, team's repos cloned, agent rules configured, credentials given, and any other data installed.

### Use the agents you already pay for

Claude Code and Codex come installed in the agent sandbox. Or optionally install any agent harness, and use your existing billing plan.

### Build tools and workflows

Use agents to build your own dashboards, CRMs, and task managers. Each ships with a backend, auth, and a URL, and are shareable like a google drive.

## Installation

### Automated agent setup

Paste this prompt into your coding agent:

```text
Self-host BlitzOS from this repo. Read docs/SELF-HOST.md. Follow its steps in order. Ask me for the accounts you need: Cloudflare, a spare domain, Google OAuth, and Hetzner or a Firecracker host.
```

### Manual setup

Follow the [self-host guide](docs/SELF-HOST.md).

## More built in

- **Connections** Connect GitHub, Google Workspace, Linear, Discord, and YouTrack with provider-specific authorization: member OAuth or personal tokens, or admin-managed organization credentials. Enable connections per workspace, and let agents request access.
- **Shared drive** Share folders with teammates, attach them to workspaces, and sync new and updated files both ways for members with editor access or higher.
- **Teenyapps** Discover and preview apps running in a workspace, then save links to deployed versions in the same panel.
- **Bring your own cloud** Run workspaces on Hetzner, AWS, or your own Firecracker hosts, and deploy the control plane in your Cloudflare account.

## Packages

- [`box`](packages/box/README.md) the complete workspace runtime: SSH, Docker, agent harnesses, terminal, files, and previews.
- [`control-plane`](packages/control-plane/README.md) workspaces, member machines, roles, credential injection, volumes, and compute providers.
- [`microvm-host`](packages/microvm-host/README.md) the Go host agent that runs and networks Firecracker workspaces.
- [`webApp`](packages/webapp/README.md) the browser webApp for creating, configuring, sharing, and working inside workspaces.
- [`broker`](packages/broker/README.md) short-lived Claude and Codex credential delivery for workspace fleets.
- [`schema`](packages/schema/README.md) shared wire types and cross-runtime conformance fixtures.

## Docs

- [Self-host guide](docs/SELF-HOST.md) clone to first workspace, in order.
- [Workspace tunnels](docs/TUNNEL.md) browser access to cloud-VM workspaces.
- [Box image](docs/BOX-IMAGE.md) build, publish, and upgrade the workspace image.
- [Automatic evals](docs/AUTOMATIC-EVALS.md) turn captured agent usage into an eval suite.
- [Contributing](CONTRIBUTING.md) the three gates, the lint ratchet, fixtures, commit style.
- [Security](SECURITY.md) reporting, secret blast radius, the workspace trust model.
- Packages: [box](packages/box/README.md) · [control-plane](packages/control-plane/README.md) · [microvm-host](packages/microvm-host/README.md) · [webapp](packages/webapp/README.md) · [broker](packages/broker/README.md) · [schema](packages/schema/README.md)

## Roadmap

- [ ] sessions
- [ ] recipe triggers
- [ ] evals
- [ ] policy

Apache-2.0.
