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
a first-time user to go hunt for a preview tab — open it for them.
(`blitz preview open` is an alias for the same command.)

- `--path <path>` deep-links to a route, e.g. `blitz teenyapp open 3000 --path /dashboard`.
- `--title <name>` names the app, e.g. `blitz teenyapp open 5173 --title "Docs"`.

### How local apps reach the browser

- Listen on a TCP port in the range **1024-65535**. Avoid **7443-7446** and
  **17445**; the box uses those.
- Bind to an IPv4 loopback or wildcard address (**`127.0.0.1`** or **`0.0.0.0`**).
  Do **not** bind IPv6-only (`::1`) — it will not be reached.
- Within a few seconds the port appears in the workspace teenyapps sidebar. It
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

## Installing packages

- There is no `sudo`. Anything that needs root (including `apt`) will not work.
- `npm i -g <pkg>` works; global installs go under `/opt/blitz/npm`.
- `python3` is present, but `pip` is not. Bootstrap pip yourself if you need it
  (for example with `python3 -m ensurepip` or by fetching `get-pip.py`).
