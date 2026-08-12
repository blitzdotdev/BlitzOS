# broker

One subscription account authenticates agents in every workspace you spawn.

- Its own image, its own box. It holds the vendor credentials; workspaces
  never do.
- Mint and deposit run over forced-command SSH. One key = one operation.
- The member list comes from the control-plane feed. A key is valid exactly
  while the feed serves it. Revocation is the feed.
- Two binaries, one Go module: `blitz-broker` (broker box: enroll · sync ·
  mint · deposit) and `blitz-cred` (workspace box: enroll · register ·
  token · watch). Never co-installed.

Status: pre-build. Design record: `TODO.md`.
