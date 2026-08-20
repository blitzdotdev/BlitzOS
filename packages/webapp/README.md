# webapp

The browser webApp: workspace rail, terminal, ACP chat, files browser/editor,
and previews.

- Renders the server view. Never infers it. Retry, phase, and capability all
  come from the API.
- Talks only to the control plane. Every workspace surface — terminal, chat,
  files, previews — goes through the control plane's
  `/workspaces/:id/webapp/:port` proxy; the browser never connects to a box
  directly.
- Login: Google OAuth → HttpOnly session cookie.

## Develop

```sh
npm ci
npm run dev -w @blitzos/webapp
```

The dev server proxies the API route prefixes to the control-plane origin in
the `VITE_DEV_PROXY_TARGET` env var (read from the repo root, e.g. a root
`.env`); point it at your own deployment — such as `http://127.0.0.1:8787`
from `wrangler dev` — to work against real data. Unset, nothing is proxied
and the dev server warns.

## Build

`npm run build -w @blitzos/webapp` writes `dist/`, which the control plane
serves as Worker assets — the deploy command
(`npm run deploy -w packages/control-plane`) runs this build itself.

The built app calls the control plane on its own origin. Set
`VITE_CONTROL_PLANE_URL` at build time (read in `src/main.tsx`) only when the
control plane lives on a different origin.

Design record: `TODO.md`.
