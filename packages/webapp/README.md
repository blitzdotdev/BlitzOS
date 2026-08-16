# ui

The webApp, in the browser.

- Workspace rail, terminal, ACP chat, files browser/editor, preview.
- Renders the server view. Never infers it. Retry, phase, and capability all
  come from the API.
- Speaks the four-call API to the control plane, and ttyd/ACP/WebDAV to the
  box through one endpoint resolver: ssh tunnel, your own edge, or a hosted
  ingress — same webApp code.
- Login: operator key once → HttpOnly session.

## Develop

```sh
npm install
npm -w packages/ui run dev
```

The standalone build uses the same origin for the control plane. Set
`VITE_CONTROL_PLANE_URL` when it is elsewhere. The settings panel stores only
the three local tunnel ports; operator keys are exchanged directly for the
HttpOnly session cookie.

Design record: `TODO.md`.
