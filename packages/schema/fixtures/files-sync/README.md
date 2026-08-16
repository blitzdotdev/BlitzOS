# Files sync fixtures

Canonical JSON exchanged between the control plane and the guest `blitz-files`
CLI. `valid/list.json` covers paginated R2 listings; `valid/attachments.json`
covers the workspace attachment list. Both runtimes must accept every `valid`
fixture and reject every `invalid` fixture.
