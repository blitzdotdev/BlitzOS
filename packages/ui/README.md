# ui

The cockpit, in the browser.

- Workspace rail, terminal, ACP chat, files browser/editor, preview.
- Renders the server view. Never infers it. Retry, phase, and capability all
  come from the API.
- Speaks the four-call API to the control plane, and ttyd/ACP/WebDAV to the
  box through one endpoint resolver: ssh tunnel, your own edge, or a hosted
  ingress — same cockpit code.
- Login: operator key once → HttpOnly session → optional passkey.

Status: pre-build. Design record: `TODO.md`.
