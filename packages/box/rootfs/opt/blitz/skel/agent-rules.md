# Blitz box — agent rules

These rules are managed by Blitz. This file is overwritten every time the box
restarts, so do not edit it. Put project-specific rules in
`/workspace/CLAUDE.md` instead — that file is yours and survives restarts.

## Showing a preview to the user

When you start a web UI, dev server, or static HTML page for the user, run:

```
blitz preview open <port>
```

This makes the platform **open the preview for the user**. Do it as soon as the
server is listening. Never tell a first-time user to go hunt for a preview tab —
open it for them.

- `--path <path>` deep-links to a route, e.g. `blitz preview open 3000 --path /dashboard`.
- `--title <name>` names the preview, e.g. `blitz preview open 5173 --title "Docs"`.

### How previews reach the browser

- Listen on a TCP port in the range **1024-65535**. Avoid **7443-7446** and
  **17445**; the box uses those.
- Bind to an IPv4 loopback or wildcard address (**`127.0.0.1`** or **`0.0.0.0`**).
  Do **not** bind IPv6-only (`::1`) — it will not be reached.
- Within a few seconds the port appears in the workspace preview sidebar. It is
  served to the browser at `/workspaces/<workspace-id>/webapp/7445/preview/<port>/`.
- Do **not** try to fetch that URL yourself from inside the box. The browser
  holds an auth token that the box does not, so the request will fail from here.
  Just start the server and open the preview.

## Sharing a public link

To surface a public link you created (for example a `blitz.dev` app you
deployed), use:

```
blitz preview add <url> --title "<name>"
blitz preview list
blitz preview rm <url>
```

Only `https` `*.blitz.dev` links open inline in the preview. Any other link
opens in a new browser tab.

## Installing packages

- There is no `sudo`. Anything that needs root (including `apt`) will not work.
- `npm i -g <pkg>` works; global installs go under `/opt/blitz/npm`.
- `python3` is present, but `pip` is not. Bootstrap pip yourself if you need it
  (for example with `python3 -m ensurepip` or by fetching `get-pip.py`).
