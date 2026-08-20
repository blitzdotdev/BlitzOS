<h1 align="center">BlitzOS</h1>

<p align="center"><strong>Build your AI Operating System</strong></p>

<p align="center">
  <a href="#capabilities">Capabilities</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#packages">Packages</a>
</p>

<p align="center">
  <img src="docs/images/workspace.png" alt="A BlitzOS workspace: agent terminal, chat, files, and connections in the browser" width="100%">
</p>


# What's an AI Operating System? 

Just as a traditional OS makes you more productive with computers, an AI OS makes you more productive with AI.

Our definition:

> A system that provides abstractions for managing the AI's credentials, context, and resources. These abstractions help people build and evaluate new AI workflows, while managing tradeoffs between cost and performance.

# Why BlitzOS exists

AI continues to progress. But converting AI progress into org productivity hard. There are roughly three challenges that make it hard, which BlitzOS exists to solve.

1) **Keeping up with the frontier**. What AI can't do today might be doable tomorrow with a new AI. But this requires constantly testing new AIs. BlitzOS makes testing new AIs easy by providing work environment with org context and connections already loaded. 

2) **Sharing working AI setups**. Not everyone in the org will actively experiment with AI. But in BlitzOS, those  who do can share their already working setup with everyone. 

3) **Managing cost/performance tradeoff**. Which AI can do what job, how well, and at what cost? Only way to know is to evaluate AI on real work. BlitzOS automatically generates evals, so you can make cost/perf tradeoffs across all AI work in your og. 
 
While the open core of BlitzOS solves all above problems, the intention is for you to customize BlitzOS to make your company's own AI OS.

## BlitzOS features

- **Agent workspaces** Sandboxed cloud computers holding only the credentials and data AI agents need.
- **Multiplayer** Setup AI environment once in a workspace, then share it with teammates.
- **Teenyapps** Mini apps you can vibe-code to build internal tools like dashboards, CRMs, task managers in BlitzOS - each comes with a backend, auth and URL
- **Automatic Evals** A built-in eval agent generates agent evals based on aggregated real AI usage data across your org. 
- **Recipes** Like skills but on steroids, recipes let you capture the entire runtime of a successful agent workflow (AI model, machine env, data + credentials) and invoke it at scale.  
- **Agent Drive** Upload files to the agent drive to attach it to any workspace, or share with any teammate.
- **Workspace API** Agents can use the workspace API to provision any allowed {machine, data, credentials} combination for their own subagents through the API.

Also, BlitzOS is BYO agent and cloud

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


# Roadmap

- [ ] recipes
- [ ] evals
- [ ] policy

Apache-2.0.
