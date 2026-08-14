# BlitzOS core

The open core of BlitzOS. Apache-2.0.

## What is BlitzOS

BlitzOS is infrastructure for your company's 

## Capabilities

- Your orchestrating agent can call the workspace API to provision a scoped
  computer for its subagents, and you can watch/steer subagents
- Use one subscription to authenticate and run agents on multiple different
  computers.
- Built-in webui: The webui allows you to create workspaces, spawn agent
  sessions in it, and talk to them via TUI/ChatUI tabs.

## Packages

- [`box`](packages/box/README.md) — one Linux OCI image = one complete agent workspace: key-only ssh,
  browser terminal (ttyd + tmux), ACP agent chat, WebDAV files. Claude Code +
  Codex installed.
- [`broker`](packages/broker/README.md) — runs agents in many boxes on one subscription-billed account: it
  holds the refresh token and issues short-lived tokens to boxes.
- [`control-plane`](packages/control-plane/README.md) — the backend: the workspace API
  (create · poll · destroy, with ssh metadata in the workspace view) over your
  cloud, plus sessions and the broker registry.
- [`ui`](packages/ui/README.md) — the web app: workspace manager, terminal, agent chat, filesystem viewer,
  port preview.
- [`schema`](packages/schema/README.md) — one contract for all packages: workspace types, enums, wire
  shapes, ACP conformance fixtures.

## Architecture

```
            you · your agents · browser
                       │
                       ▼
                  ┌──────────┐
                  │    ui    │
                  └────┬─────┘
                       │  API: create · poll · destroy
                       │  (ssh metadata in workspace view)
                       ▼
           ┌────────────────────────┐           ┌─────────────┐
           │      control-plane     │◀──────────│   broker    │
           │  sessions · registry   │ pull feed │ vendor creds│
           └────┬───────────────────┘           └─────▲───────┘
                │ VmProvider · VolumeProvider         │
                ▼                                     │ SSH mint / deposit
           ┌────────────────────────┐                 │
           │ your cloud: VM + volume│                 │
           └────┬───────────────────┘                 │
                │ boots ── phone_home ─▶ ready        │
                │ (response = box credential)         │
                ▼                                     │
           ┌────────────────────────┐                 │
           │          box           │─────────────────┘
           │ sshd 22 · ttyd 7443    │
           │ ACP 7444 · files 7445  │◀── you · ui · your agents
           └────────────────────────┘    ssh 22 public; 7443–7445 loopback,
                                         via ssh tunnel or your own edge

           schema: one contract under all of it —
           control-plane implements it · ui imports it · box tests against it
```

- One auth rule everywhere: HTTP plane = tokens. SSH plane = keypairs.
- One state rule everywhere: chat lives in the box journal. Workspace truth
  lives in the control plane. Credentials live on your disks.

## Prerequisites

- Node.js `^22.13.0 || >=24.0.0` and npm.
- Wrangler, run through `npx wrangler` (no global install required).
- Docker for box work. On macOS, use Colima and run `unset DOCKER_HOST` so
  Docker uses the Colima context.

**Use a DEDICATED Hetzner project for a control plane. Janitor operations must
never share a project with other infrastructure.**

## Installation

Exact commands live in each package README. Three ways in, smallest first:

1. **One box, no server.** `docker run` the box image on any machine
   ([`packages/box/README.md`](packages/box/README.md)). ssh in, `claude login` once. You get a terminal (7443),
   agent chat (7444), and files (7445) over an ssh tunnel. No account. No
   control plane.
2. **A fleet on your cloud.** Deploy the control plane with a cloud adapter
   ([`packages/control-plane/README.md`](packages/control-plane/README.md) — Hetzner ships; write your own against two
   small interfaces) and serve the cockpit
   ([`packages/ui/README.md`](packages/ui/README.md)). Create, poll,
   and destroy workspaces from the cockpit or from any agent over HTTP.
3. **One subscription, many workspaces.** Run the broker image and enroll it
   ([`packages/broker/README.md`](packages/broker/README.md)). Every workspace you spawn authenticates its agents
   against your one account, with short-lived tokens minted per turn.
