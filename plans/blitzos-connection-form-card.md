# Connection-backed form card (edit + act from chat)

Goal: edit a draft and hit Send from inside the agent chat, with a REAL send. First instance:
the Gmail compose card (image #1's "platonic ideal"), but built as the general mechanism, not a
Gmail hack. The moat vs ChatGPT: BlitzOS is connected to the real Gmail, so Send actually sends.

## Core decision — data, NOT UI (this is the speed)
The agent does NOT generate the Gmail-like markup. A PREBUILT generic form-card component ships in
the island bundle (renders instantly). The agent emits a tiny structured part = data only:
```
blitz-ui form
{ "conn": "conn_ab12", "title": "Reply to Emilie",
  "fields": [{ "name":"to","value":"emilie@acme.vc" },
             { "name":"subject","value":"Re: transfer-units route" },
             { "name":"body","value":"Hi Emilie, …","multiline":true }],
  "actions": [{ "label":"Send","primary":true,"tool":"gmail_send" }] }
```
Generic = fields + actions backed by a connection. Compose is one shape; the same card covers a
Linear comment, a calendar invite, any connected app. No per-site UI.

## Flow
1. Agent reads/drafts (already does today) → emits the `form` part with the draft as field values.
2. Card renders instantly, populated. Editing fields = LOCAL state, zero agent round trips.
3. An action runs the connection: `connection_call_tool(conn, action.tool, fieldValues)` →
   one `run_js` that fills the real Gmail compose + clicks send. Effect-verified return → the card
   shows "sent" only when it really landed (stale/empty effect ⇒ "couldn't send", re-derive).

## Speed levers
- Prebuilt UI, not LLM-authored markup (the big one).
- Stream the card shell the moment the agent commits; fill body as the draft streams.
- Initial values are the already-drafted text (no extra fetch); editing never hits the agent.
- Send = single DOM write into the already-open tab, not char-by-char typing.
- Cache the fill+send JS as a saved per-sourceId tool (`connection_save_tool`) → derived once for
  mail.google.com, reused instantly forever after.

## Exists vs new
- Exists: the connection + read/act/run_js + saved tools; chat already renders interactive blocks
  (the choice cards); the per-connId widget→tool bridge (`connectionForSurface`).
- New (bounded): a `form` message-part type + parser in `messageParts.ts`; the `<FormCard>`
  component (island design kit, Gmail-ish for compose); wiring its actions to `connection_call_tool`
  + optimistic/effect-verified Send state.

## Open questions
- Reuse the `blitz-ui` fence (like choice cards) or a new typed part? (lean: reuse the fence.)
- Widgets were deferred past V1 — this pulls an interactive-card tier forward. Confirm scope.
- Send recipe: drive Gmail's own compose (run_js) vs Gmail draft API? (lean: run_js, no API keys.)
