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

## Expressivity tier — agent composes from a UI kit (the library option)
The data-card is the FAST/known path. For the long tail (a layout no card fits), let the agent compose
JSX from a curated, connection-aware React kit — and we ALREADY have the pipeline: `widget-catalog.mjs`
(the curated import registry) + `widget-jsx-core.mjs` (Sucrase compile at mount) + sandboxed `srcdoc` +
the `window.blitz` bridge + authored-widget save/reuse. The V1 cut removed only the CANVAS host; the
compiler + library survive. So treat both as ONE library at different altitudes:
- high-level (`<Compose to subject body onSend={conn}/>`) — props ≈ data, nearly as cheap + reliable as
  the data-card (this IS the prebuilt card, exposed as a component).
- low primitives (`<Stack><Field/><RichText/><ConnAction tool=…/></Stack>`) — full expressivity.
Speed + reliability scale with how HIGH the agent stays.

Tradeoffs vs pure data-cards:
- + any layout (no per-shape prebuild), native look IF kit-styled, behavior/wiring/security baked into
  components, reuse via saved authored widgets.
- − slower: LLM authors JSX + a compile-at-mount step (data-card > kit-JSX > raw-HTML).
- − reliability: free-form JSX errors (bad prop/name, unclosed) → need schema-validate + error boundary
  + a repair loop; a data-card is just validated JSON.
- − streaming: a half-streamed JSX blob can't render → show a skeleton from the component name.
- − discoverability: the agent must KNOW the kit API (system prompt vs a fetch tool; bigger kit = more
  to teach + staleness).
- − versioning: the registry is baked into the bundle (add/change a component = rebuild); the agent's
  API knowledge must track the shipped version or widgets break.
- − design drift: a kit constrains but does not GUARANTEE good layout; cards do.
Mitigations: keep high-level components as the default; cache compiled output by source hash; save
authored widgets per source/task (reuse, no regen); validate props against the registry's typed API.

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
- Exists: connection + read/act/run_js + saved tools; chat renders interactive blocks (choice cards);
  the per-connId widget→tool bridge (`connectionForSurface`); AND the whole widget pipeline — curated
  registry (`widget-catalog`), JSX-at-mount compile (`widget-jsx-core`, `sucrase` dep), sandboxed
  `srcdoc` + `window.blitz` bridge, authored-widget reuse. Only the canvas HOST was cut.
- New (bounded): data-card tier → a `form` part + parser (`messageParts.ts`) + a `<FormCard>` (island
  kit) wired to `connection_call_tool` (optimistic/effect-verified Send). Library tier → an in-chat
  widget host (the cut canvas host is gone) + flesh the registry into a connection-aware island kit.

## Open questions
- Data-card tier first or library tier first? (lean: ship `<Compose>` as a high-level kit component —
  it IS both the fast card AND the library's top altitude, so one build serves both tiers.)
- Reuse the `blitz-ui` fence (like choice cards) or a new typed part? (lean: reuse the fence.)
- Widgets were deferred past V1 — this pulls an interactive-card tier forward. Confirm scope.
- Send recipe: drive Gmail's own compose (run_js) vs Gmail draft API? (lean: run_js, no API keys.)
