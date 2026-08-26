<h1 align="center">BlitzOS</h1>

<p align="center"><strong>Your company's AI Operating System</strong></p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#packages">Packages</a>
</p>

<p align="center">
  <img src="docs/images/workspace.png" alt="A BlitzOS workspace with an agent terminal, files, and workspace tools in the browser" width="100%">
</p>

# Features

**BYO agent and run them on any cloud** 

- **Agent workspaces** Shareable, sandboxed cloud computers holding only the credentials and data AI agents need.
- **Workspace templates** Create agent workspace templates defining what repos, credentials, machine environment, etc. are put in the agent workspace. Set up once and share with everyone. 
- **Recipes** Like skills but on steroids: define the runtime of a successful agent workflow (AI model, machine env, data + credentials) and trigger it with a webhook from Slack, GitHub, etc.
- **Teenyapps** Mini apps you can vibe-code to build internal tools like dashboards, CRMs, and task managers — each comes with a backend, auth, and a URL.

# About

An operating system turns a bare machine into a standard environment where programs just run. BlitzOS does the same for AI: it turns the context, credentials, and workflows your fast adopters have dialed in into reusable, standardized workspaces that the rest of the company can just use, without learning the agent setup themselves.

When a new AI agent drops, a developer tests it in a fresh "daily driver" workspace from a company template. That template preconfigures the repos, API keys, and agent skill library, and nothing else. The clean boundary keeps the agent safe to run on real work in the cloud, unlike a local machine where every other project's credentials and configs are reachable.

If the agent does something interesting, developers share the workspace like a Google Doc. If it's genuinely better but needs config tweaks, one developer publishes an updated template and everyone rolls it out.

BlitzOS helps companies digest AI advancements as fast as they happen. Workspaces, templates, and recipes enable **faster experimentation** and **workflow sharing**, and features like automatic evals build on them to optimize AI cost.

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
- [`control-plane`](packages/control-plane/README.md) workspace lifecycle, sessions, access, credential injection, volumes, and compute providers.
- [`microvm-host`](packages/microvm-host/README.md) the Go host agent that runs and networks Firecracker workspaces.
- [`webApp`](packages/webapp/README.md) the browser webApp for creating, configuring, sharing, and working inside workspaces.
- [`broker`](packages/broker/README.md) short-lived Claude and Codex credential delivery for workspace fleets.
- [`schema`](packages/schema/README.md) shared wire types and ACP conformance fixtures.

# Docs

- [Self-host guide](docs/SELF-HOST.md) clone to first workspace, in order.
- [Workspace tunnels](docs/TUNNEL.md) browser access to cloud-VM workspaces.
- [Box image](docs/BOX-IMAGE.md) build, publish, and upgrade the workspace image.
- [Automatic evals](docs/AUTOMATIC-EVALS.md) turn captured agent usage into an eval suite with one recipe.
- [Contributing](CONTRIBUTING.md) the three gates, the lint ratchet, fixtures, commit style.
- [Security](SECURITY.md) reporting, secret blast radius, the workspace trust model.
- Packages: [box](packages/box/README.md) · [control-plane](packages/control-plane/README.md) · [microvm-host](packages/microvm-host/README.md) · [webapp](packages/webapp/README.md) · [broker](packages/broker/README.md) · [schema](packages/schema/README.md)


# Roadmap

- [ ] recipes
- [ ] evals
- [ ] policy

Apache-2.0.
