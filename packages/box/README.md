# box

One OCI image = one complete agent workspace. Install = docs: one
`docker run` line, pinned by digest. Runs on amd64, arm64, and Mac (Colima).

- Four surfaces, nothing else: key-only sshd (22) · ttyd + tmux terminal
  (7443) · ACP session endpoint (7444) · WebDAV files server (7445).
- The ACP actor: one actor per session, serialized turns, SQLite journal,
  `session/load` replay, N subscribers. Claude Code + Codex, official and
  pinned.
- Runs with no control plane. No config → the box skips enrollment and uses
  the credentials in HOME on its state volume. Attach a control plane later;
  enrollment is a device flow (standalone) or delivered at provision
  (hosted).
- One state volume holds everything that must survive: identity, host keys,
  HOME, the session journal.

Status: pre-build. Design record: `TODO.md`.
