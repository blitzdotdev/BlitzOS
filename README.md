<h1 align="center">BlitzOS</h1>

<p align="center"><strong>Your company's AI Operating System</strong></p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#about">About</a> •
  <a href="#packages">Packages</a>
</p>

<p align="center">
  <img src="docs/images/workspace.png" alt="A BlitzOS workspace: agent terminal, files, and connections in the browser" width="100%">
</p>

# Features

**BYO agent and run them on any cloud**

- **Agent workspaces** Shareable, sandboxed cloud computers holding only the credentials and data AI agents need.
- **A machine for every member** Join a workspace like you join a Discord server: your own machine is already running, preloaded with the team's repos, rules, and keys. Nobody files a ticket for a VM.
- **Workspace credentials** Sealed, workspace-scoped API keys that agents fetch at the moment of use with `blitz-cred`. Nothing ambient, nothing in a dotfile, revocation that actually revokes.
- **Everyone acts as themselves** Your GitHub and your agent subscriptions stay yours on your machine. Commits carry your name, tokens spend your identity — even in a workspace the whole team shares.
- **Teenyapps** Mini apps you can vibe-code to build internal tools like dashboards, CRMs, and task managers — each comes with a backend, auth, and a URL.

# About

An operating system turns a bare machine into a standard environment where programs just run. BlitzOS does the same for AI: it turns the context, credentials, and workflows your fast adopters have dialed in into reusable, standardized workspaces that the rest of the company can just use, without learning the agent setup themselves.

When a new AI agent drops, a developer tests it on their own machine inside the team workspace. The workspace preconfigures the repos, API keys, and agent rules, and nothing else. The clean boundary keeps the agent safe to run on real work in the cloud, unlike a local machine where every other project's credentials and configs are reachable.

If the setup is genuinely better, spreading it is one action: add a teammate, and a machine with the same repos, rules, and keys is theirs before their first click. A workspace **is** its own template — when a configuration is worth keeping, clone the workspace and the next team starts where this one left off.

BlitzOS helps companies digest AI advancements as fast as they happen. Workspaces and member machines enable **faster experimentation** and **workflow sharing**, and features like automatic evals build on them to optimize AI cost.

# Installation

### Automated agent setup

Paste this prompt into your coding agent:

```text
Self-host BlitzOS from this repo. Read docs/SELF-HOST.md. Follow its steps in order. Ask me for the accounts you need: Cloudflare, a spare domain, Google OAuth, and Hetzner or a Firecracker host.
```

### Manual setup

Follow the [self-host guide](docs/SELF-HOST.md).


# Packages

- [`box`](packages/box/README.md) the complete workspace runtime: SSH, Docker, agent harnesses, terminal, files, and previews.
- [`control-plane`](packages/control-plane/README.md) workspaces, member machines, roles, credential injection, volumes, and compute providers.
- [`microvm-host`](packages/microvm-host/README.md) the Go host agent that runs and networks Firecracker workspaces.
- [`webApp`](packages/webapp/README.md) the browser webApp for creating, configuring, sharing, and working inside workspaces.
- [`broker`](packages/broker/README.md) short-lived Claude and Codex credential delivery for workspace fleets.
- [`schema`](packages/schema/README.md) shared wire types and cross-runtime conformance fixtures.

# Docs

- [Self-host guide](docs/SELF-HOST.md) clone to first workspace, in order.
- [Workspace tunnels](docs/TUNNEL.md) browser access to cloud-VM workspaces.
- [Box image](docs/BOX-IMAGE.md) build, publish, and upgrade the workspace image.
- [Automatic evals](docs/AUTOMATIC-EVALS.md) turn captured agent usage into an eval suite with one recipe.
- [Contributing](CONTRIBUTING.md) the three gates, the lint ratchet, fixtures, commit style.
- [Security](SECURITY.md) reporting, secret blast radius, the workspace trust model.
- Packages: [box](packages/box/README.md) · [control-plane](packages/control-plane/README.md) · [microvm-host](packages/microvm-host/README.md) · [webapp](packages/webapp/README.md) · [broker](packages/broker/README.md) · [schema](packages/schema/README.md)


# Roadmap

- [ ] sessions
- [ ] recipes
- [ ] evals
- [ ] policy

Apache-2.0.
