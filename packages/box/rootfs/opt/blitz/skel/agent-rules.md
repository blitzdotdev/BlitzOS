# Blitz box — agent rules

These rules are managed by Blitz. This file is overwritten every time the box
restarts, so do not edit it. Put project-specific rules in
`/workspace/CLAUDE.md` instead — that file is yours and survives restarts.

## Showing a running app to the user

When you start a web UI, dev server, or static HTML page for the user, run:

```
blitz teenyapp open <port>
```

This makes the platform **open the app for the user**. It works for any local
app, not only teenyapps. Do it as soon as the server is listening. Never tell
a first-time user to go hunt for a teenyapp tab — open it for them.
(`blitz preview open` is an alias for the same command.)

- `--path <path>` deep-links to a route, e.g. `blitz teenyapp open 3000 --path /dashboard`.
- `--title <name>` names the app, e.g. `blitz teenyapp open 5173 --title "Docs"`.

### How local apps reach the browser

- Listen on a TCP port in the range **1024-65535**. Avoid **7443-7446** and
  **17445**; the box uses those.
- Bind to an IPv4 loopback or wildcard address (**`127.0.0.1`** or **`0.0.0.0`**).
  Do **not** bind IPv6-only (`::1`) — it will not be reached.
- Within a few seconds the port appears in a workspace teenyapp tab. It
  is served to the browser at `/workspaces/<workspace-id>/webapp/7445/preview/<port>/`.
- Do **not** try to fetch that URL yourself from inside the box. The browser
  holds an auth token that the box does not, so the request will fail from here.
  Just start the server and open the app.

## Sharing a public link

To surface a public link you created (for example a `blitz.dev` app you
deployed), use:

```
blitz teenyapp add <url> --title "<name>"
blitz teenyapp list
blitz teenyapp rm <url>
```

An `https` link opens inline in the workspace when its host is on the
deployment's embed allowlist, which defaults to `*.blitz.dev` but is
configurable per deployment. Any other link opens in a new browser tab.

## When a connection is not authorized

If a tool or API call fails because a provider connection is not authorized —
a connect-\<provider\> error, a credential mint that reports no grant, or a 401
that a fresh login shell does not fix — run:

```
blitz connections open <provider>
```

This opens the workspace connections panel for the user with that provider
highlighted. Then tell the user you opened the connections panel and ask them
to authorize the provider. Do not keep retrying: the provider's tools stay
dark until they authorize it.

### After the user authorizes

A provider's credentials and its skill file arrive on this box by a sync, and
your session read its skills when it started. So once the user says they
authorized it, run:

```
blitz-cred sync
```

Then start a new session (or a new terminal tab) so the skill is loaded. Until
you do, the provider's skill will look missing even though the connection is
live.

### Do not use `/mcp` here

Workspace sessions have no MCP servers and no claude.ai connectors. Connections
arrive as environment variables and skill files, nothing else. `/mcp` and a
"connector" both answer for a different product surface — reaching for them
here only costs a turn.

## Never print a credential

Never echo, print, log, or paste the value of a credential — not into a
message, not into a file, not into a command you show the user. That includes
every `*_TOKEN`, `*_API_KEY`, and `*_SECRET` variable, and anything
`blitz-cred` hands back. Use the variable by name (`$GITHUB_TOKEN`), never by
value. A transcript is not a private place: a token that appears in one has to
be rotated.

`blitz-cred list` names the connections this workspace holds and the variables
they set, without printing a single value. Use it instead of dumping the
environment.

## Installing packages

- There is no `sudo`. Anything that needs root (including `apt`) will not work.
- `npm i -g <pkg>` works; global installs go under `/opt/blitz/npm`.
- `curl`, `gh`, `git`, `node`, and `python3` are installed. `pip` is not:
  bootstrap it yourself if you need it (`python3 -m ensurepip`, say).
