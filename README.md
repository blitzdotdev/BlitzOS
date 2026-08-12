# BlitzOS core

The open core of BlitzOS. Apache-2.0.

## What is BlitzOS

BlitzOS is an open-source library for building your own cloud agent product
(Cursor Cloud, AmpCode, Grok Bot are examples). "Cloud agent" is the concept
of enabling AI agents do increasingly complex, long-horizon work by giving
them dedicated computers. Cloud agent products package and sell this concept
as a product. While this is convenient, you pay extra for compute & storage
and cannot customize cloud agents for your use case. BlitzOS exists so you
can build & self-host your own cloud agent product as frictionlessly as
buying an existing product, while enjoying stronger capabilities from
customization.

## Capabilities

- Your orchestrating agent can call the workspace API to provision a scoped
  computer for its subagents, and you can watch/steer subagents
- Use one subscription to authenticate and run agents on multiple different
  computers.
- Built-in webui: The webui allows you to create workspaces, spawn agent
  sessions in it, and talk to them via TUI/ChatUI tabs.

## Packages

- `box` — one Linux OCI image = one complete agent workspace: key-only ssh,
  browser terminal (ttyd + tmux), ACP agent chat, WebDAV files. Claude Code +
  Codex installed.
- `broker` — runs agents in many boxes on one subscription-billed account: it
  holds the refresh token and issues short-lived tokens to boxes.
- `control-plane` — the backend: the four-call workspace API (create · poll ·
  destroy · ssh) over your cloud, plus sessions and the broker registry.
- `ui` — the cockpit web app: workspace rail, terminal, agent chat, files,
  preview. It renders the server view.
- `schema` — one contract for all packages: workspace types, enums, wire
  shapes, ACP conformance fixtures.

## Architecture

```
            you · your agents · browser
                       │
                       ▼
                  ┌──────────┐
                  │    ui    │
                  └────┬─────┘
                       │  four-call API: create · poll · destroy · ssh
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

## Installation

Exact commands live in each package README. Three ways in, smallest first:

1. **One box, no server.** `docker run` the box image on any machine
   (`box/README.md`). ssh in, `claude login` once. You get a terminal (7443),
   agent chat (7444), and files (7445) over an ssh tunnel. No account. No
   control plane.
2. **A fleet on your cloud.** Deploy the control plane with a cloud adapter
   (`control-plane/README.md` — Hetzner ships; write your own against two
   small interfaces) and serve the cockpit (`ui/README.md`). Create, poll,
   and destroy workspaces from the cockpit or from any agent over HTTP.
3. **One subscription, many workspaces.** Run the broker image and enroll it
   (`broker/README.md`). Every workspace you spawn authenticates its agents
   against your one account, with short-lived tokens minted per turn.

Status: pre-build. The code lands in a fresh repo; this monorepo then deletes
its core code and consumes the packages.
