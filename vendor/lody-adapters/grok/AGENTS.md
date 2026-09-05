# Grok ACP adapter guidelines

`CLAUDE.md` is a symlink to this file. The public Lody repository guidelines also apply.

## Model snapshot settling

- Official Grok 1.0.13 may return a provisional model roster from `session/new`, then emit
  `_x.ai/models/update` later. The update has no session id and is a process-level complete
  snapshot containing `currentModelId` and `availableModels`.
- The production adapter must settle a pending session response from that explicit snapshot
  signal. If the snapshot arrives first, reuse it for the response. If the response arrives
  first, defer it only until the signal or the bounded safety timeout; never use an unconditional
  sleep.
- After a session response is already visible, translate a new snapshot to standard ACP
  `config_option_update`. Do not expose the provider-specific notification to Lody business code.
- Tests must deterministically cover initial 4.5 followed by a complete 4.6 + 4.5 snapshot, the
  reverse ordering, and the bounded fallback. Do not depend on scheduler timing or a real runtime.
- This settling happens inside the existing ACP process. It must not add Streams/Flock
  subscriptions or change connection cardinality.
