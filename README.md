<h1 align="center">BlitzOS</h1>

<p align="center"><strong>Build your AI Operating System</strong></p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#packages">Packages</a>
</p>

<p align="center">
  <img src="docs/images/workspace.png" alt="A BlitzOS workspace: agent terminal, chat, files, and connections in the browser" width="100%">
</p>


# What's an AI Operating System? 

> A system manages how AI works inside an organization: what it can access, what context it receives, where it runs, and how its work is evaluated. It provides primitives for building, sharing, and evaluating AI workflows across an organization.

Just as a traditional OS makes you more productive with computers, an AI OS makes your org more productive with AI.

# Why BlitzOS exists


AI capabilities improve faster than orgs can adopt them. BlitzOS closes that gap by helping teams:

1. **Test the frontier.** Run new models on real work with the right org context, tools, and connections already configured.
2. **Share what works.** Turn successful setups from AI pioneers in the org into reusable workspaces and workflows for the rest of the organization.
3. **Optimize cost and quality.** Evaluate models on real work to learn which model should do each job.

Together, these form an org learning loop:

```text
┌─ WORLD ─────────────────────────────────────────────┐
│                                                     │
│               new AI model expands                  │
│            frontier of what's possible              │
│                                                     │
└─────────────────────────┬───────────────────────────┘
                          ▼
┌─ ORGANIZATION ──────────────────────────────────────┐
│                                                     │
│    ┌────▶ pioneers experiment and discover          │
│    │        the frontier of AI work                 │
│    │                     │                          │
│    │                     ▼                          │
│    │             frontier diffuses                  │
│    │             throughout the org                 │
│    │                     │                          │
│    │                     ▼                          │
│    └────── org capacity and efficiency grows        │
│                                                     │
└─────────────────────────────────────────────────────┘
```
BlitzOS exists to let you run that loop out of the box.

# Features

- **Agent workspaces** Sandboxed cloud computers holding only the credentials and data AI agents need.
- **Multiplayer** Setup AI environment once in a workspace, then share it with teammates.
- **Teenyapps** Mini apps you can vibe-code to build internal tools like dashboards, CRMs, task managers in BlitzOS - each comes with a backend, auth and URL
- **Automatic Evals** A built-in eval agent generates agent evals based on aggregated real AI usage data across your org. 
- **Recipes** Like skills but on steroids, recipes let you capture the entire runtime of a successful agent workflow (AI model, machine env, data + credentials) and invoke it at scale.  
- **Agent Drive** Upload files to the agent drive to attach it to any workspace, or share with any teammate.
- **Workspace API** Agents can use the workspace API to provision any allowed {machine, data, credentials} combination for their own subagents through the API.

By default, BlitzOS is BYO agent and cloud

# Installation

Self-hosting BlitzOS needs:

- a Cloudflare account — the control plane is one Worker using D1, R2, and cron triggers;
- a spare domain you can add as a zone on that account, for workspace tunnels;
- a Google Cloud project — Google OAuth is the only login method;
- workspace compute: a Hetzner Cloud project, **or** your own Firecracker host running the microvm-host agent;
- Node.js 22.13+, npm, and Docker.

Then follow the [self-host guide](docs/SELF-HOST.md): clone → deploy the
control plane → Google OAuth → tunnel → box image → first workspace.

Built-in providers are Hetzner and Firecracker. Any other cloud is one
`VmProvider` implementation, not a fork — see the
[control-plane README](packages/control-plane/README.md).


# Packages

- [`box`](packages/box/README.md) — the complete workspace runtime: SSH, Docker, agent harnesses, terminal, chat, files, and previews.
- [`control-plane`](packages/control-plane/README.md) — workspace lifecycle, sessions, access, credential injection, volumes, and compute providers.
- [`microvm-host`](packages/microvm-host/README.md) — the Go host agent that runs and networks Firecracker workspaces.
- [`webApp`](packages/webapp/README.md) — the browser webApp for creating, configuring, sharing, and working inside workspaces.
- [`broker`](packages/broker/README.md) — short-lived Claude and Codex credential delivery for workspace fleets.
- [`schema`](packages/schema/README.md) — shared wire types and ACP conformance fixtures.

# Docs

- [Self-host guide](docs/SELF-HOST.md) — clone to first workspace, in order.
- [Workspace tunnels](docs/TUNNEL.md) — browser access to cloud-VM workspaces.
- [Box image](docs/BOX-IMAGE.md) — build, publish, and upgrade the workspace image.
- [Automatic evals](docs/AUTOMATIC-EVALS.md) — turn captured agent usage into an eval suite with one recipe.
- [Contributing](CONTRIBUTING.md) — the three gates, the lint ratchet, fixtures, commit style.
- [Security](SECURITY.md) — reporting, secret blast radius, the workspace trust model.
- Packages: [box](packages/box/README.md) · [control-plane](packages/control-plane/README.md) · [microvm-host](packages/microvm-host/README.md) · [webapp](packages/webapp/README.md) · [broker](packages/broker/README.md) · [schema](packages/schema/README.md)


# Roadmap

- [ ] recipes
- [ ] evals
- [ ] policy

Apache-2.0.
