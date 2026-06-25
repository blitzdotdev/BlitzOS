# Security Policy

BlitzOS is an Electron macOS AI-agent "dynamic island" that, by design, gives an
AI agent real reach into your machine: it can drive your logged-in browser and
native apps, holds sensitive macOS privacy grants, and accepts instructions from
agents over a public relay. That reach is the product — and it is also the threat
surface. We take security reports seriously and want to make it easy to report
problems responsibly.

## Supported versions

BlitzOS is early-stage software (prototype, `0.0.x`). We currently provide
security fixes only for the **latest released version** on the default branch.
There are no long-term-support branches yet.

| Version            | Supported          |
| ------------------ | ------------------ |
| Latest release     | :white_check_mark: |
| Older `0.0.x`      | :x:                |
| Pre-release / forks| :x:                |

Always upgrade to the latest version before reporting a vulnerability, so we can
confirm it is not already fixed.

## Reporting a vulnerability

**Please do not open a public GitHub issue, pull request, or discussion for a
security vulnerability.** Public disclosure before a fix is available puts users
at risk.

Use either of these private channels:

1. **GitHub Private Vulnerability Reporting (preferred).** Open a private
   security advisory at
   <https://github.com/blitzdotdev/blitzos-oss/security/advisories/new> (or via
   the repository's **Security → Report a vulnerability** tab). This keeps the
   report confidential and lets us collaborate on a fix and coordinated
   disclosure in one place.
2. **Email (fallback).** Send details to **palashbansal96@gmail.com**. If you
   want to encrypt the report, ask in an initial message and we will share a key.

### What to include

The more of this you can provide, the faster we can triage:

- A clear description of the issue and the security impact (what an attacker
  gains).
- The component(s) involved (e.g. the localhost control server, the agent-socket
  relay path, the connector browser extension, the computer-use helper, the
  popup/permission policy).
- The affected version / commit, your OS version, and how BlitzOS was installed
  (packaged `.app` vs. dev build).
- Step-by-step reproduction, a proof-of-concept, and any logs (with secrets such
  as the control-server bearer token redacted — see below).

### Please do

- Give us a reasonable time to investigate and fix before any public disclosure.
- Limit testing to instances you own. Do not test against other users, the
  shared relay infrastructure, or third-party accounts/services that the agent
  might reach through a connection.
- Avoid accessing, modifying, or exfiltrating data that is not yours, and avoid
  service degradation (DoS) and spam.

### Please don't

- Disclose the issue publicly until we have published a fix or agreed on a
  disclosure timeline.
- Use a vulnerability to access real user data, accounts, or the user's connected
  browser/app sessions beyond what is needed to demonstrate the issue.

## Our response expectations

We are a small project, so please treat these as good-faith targets rather than a
contractual SLA:

- **Acknowledgement:** within **3 business days** of your report.
- **Initial assessment / triage:** within **10 business days**, including a
  severity rating and whether we can reproduce it.
- **Fix & disclosure:** we aim to ship a fix for high-severity issues as quickly
  as is practical and to coordinate a public advisory with you. We are happy to
  credit reporters in the advisory unless you prefer to remain anonymous.

We will keep you updated as the report progresses and will let you know if we
decide an issue is out of scope (with our reasoning).

## Security model — what to know

BlitzOS deliberately trades isolation for capability. Understand these
properties before you run it, and especially before you connect untrusted agents
or sensitive accounts.

- **Agents are powerful and can be untrusted.** Any agent connected over the
  [agent-socket](https://agentsocket.dev) relay can call the BlitzOS syscalls —
  talk to you, open terminals, spawn other agents, run workflows, and act through
  your connections. The relay path is the **untrusted** path: only connect agents
  you trust, and treat a connect URL like a credential — anyone who has it can
  reach your BlitzOS.
- **It drives your REAL browser and accounts.** Connections work the user's own
  logged-in browser tabs (via the connector extension) and native app windows
  (via the computer-use helper). There is no sandboxed throwaway session — the
  agent acts as *you*, inside *your* live sessions. A compromised or
  prompt-injected agent could take actions in any account you have connected.
  Connect only what you are comfortable letting an agent operate, and review the
  act-vs-ask boundaries you set during onboarding.
- **It holds sensitive macOS TCC grants.** Driving native apps needs
  **Accessibility** and **Screen Recording** permissions. These are isolated in a
  separate, Developer-ID-signed helper app (`BlitzComputerUse.app`) that holds the
  grants under its own TCC identity, rather than on the main app — but the
  capability is still present on your machine whenever the helper is installed and
  granted. Revoke these grants in System Settings → Privacy & Security if you stop
  using computer-use connections.
- **There is a localhost control server with a bearer token.** A co-located
  ("trusted") agent on the same machine can drive BlitzOS over an HTTP API bound
  to `127.0.0.1`, authenticated by a bearer token minted into
  `~/.blitzos/session.json`. **Protect that file and token** — any local process
  that can read it gains full control of BlitzOS. Do not paste the token or that
  file's contents into logs, screenshots, or bug reports. Localhost binding is not
  a security boundary against other processes running as your user.
- **The connector browser extension is force-installed.** To connect tabs,
  BlitzOS installs a browser extension with broad access to your pages
  (read/modify DOM, run JS in connected tabs). Anyone who can tamper with the
  extension or its messaging channel can influence what the agent sees and does in
  the browser.
- **Browser guests, downloads, and permissions.** When a connection spawns a
  browser guest (e.g. an OAuth popup), downloads stream into the workspace folder
  and permission requests surface a real Allow/Block prompt, remembered per
  origin. Treat these prompts as you would in any browser — granting a sensitive
  permission grants it to the agent's reach as well.
- **Local data and journals.** BlitzOS persists chat transcripts, workspace
  state, terminal sessions, and onboarding context under the workspace folder's
  `.blitzos/` directory and `~/.blitzos/`. These may contain sensitive
  conversation content and the control token; protect them like any other private
  data on your machine.

If you believe any of these boundaries can be crossed in a way not described here
— for example, the untrusted relay path reaching a trusted-only capability, the
control token being leaked or guessable, the extension or helper being abused by a
web page or another local process, or a permission/popup-policy bypass — that is
exactly the kind of issue we want to hear about. Please report it through the
private channels above.

Thank you for helping keep BlitzOS users safe.
