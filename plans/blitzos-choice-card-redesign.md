# BlitzOS choice-card redesign — obsidian glass

**Status:** design prototype done, NOT ported. Iterate on the lab a bit more, then bring it in.

## Goal

Swap the current flat `ask` choice/confirm cards in the island chat for the **obsidian-glass**
look: a near-black panel with a fine top-bright rim light (blue cast), a soft bottom-center bloom,
depth shadows, and ghost + Apple-blue buttons. Matches the real island (pure black, white text,
system blue) instead of the current low-contrast translucent card.

## Prototype

`lab/choice-cards/index.html` — self-contained single file. Top card recreates the "Permission
Required" reference; below are representative choice/confirm cards (PII scrubbed). The right panel
tunes the material live; "Copy CSS tokens" emits the exact values. The glass is a CSS material
(backdrop-filter blur + a 1px gradient rim ring + a clipped bloom + layered shadows), no SVG
displacement — the island sits on black so the look comes from edge light + bloom + depth.

## Tweak before porting (the "iterate a bit more" list)

- Corner rim spark: the reference has one hot blue spot top-right; the lab glows evenly across the
  top. Decide even-rim vs a small conic highlight.
- `grid` variant: the lab only shows choice/confirm. Style the image/thumbnail grid layout too.
- Primary-button rule: lab marks confirm option[0] (the affirmative) as the blue primary. Confirm
  that heuristic holds, and decide if `choice` cards ever get a primary.
- Answered state: lab DROPPED the "Selected" chip. Product still needs to show the chosen answer
  (`matchingChoiceAnswer` in messageParts.ts) — design an obsidian-styled answered state.
- Motion: entrance, hover, and the working-pulse should match island timing tokens.
- a11y: keep focus-visible rings on the glass; check contrast on the ghost buttons.
- Perf: many backdrop-filter cards in one transcript — verify scroll cost in the real island.

## Port targets (where it lands)

- `src/renderer/src/notch/island.css` — replace `.isl-ask-card` / `.isl-ask-option` /
  `.isl-ask-selected` rules with the obsidian tokens (fill, rim-top/bot, bloom, lift, blur, radius).
- `src/renderer/src/notch/MarkdownMessage.tsx` — `ChoicePartMessage`: add the `.glass-fill`+`.bloom`
  and rim layers, mark the primary option, keep `onChoose`/`selectedAnswer` wiring intact.
- `src/renderer/src/notch/messageParts.ts` — no parser change; `confirm`/`choice`/`grid` layouts stay.
- Leave the agent contract untouched: `ask` tool (`src/main/os-tools.mjs`, kinds confirm/choice/grid)
  and the ```blitz-ui authoring spec (`src/main/blitzos-interview.md`) do not change — visual only.

## Notes / risks

- Visual-only change; do not alter the `say`/`ask`/return-path contract or the JSON schema.
- Tokens must read against the black chassis AND the rare frosted-over-content case (attach panel).
- Update the design refs in `island.css` comments when porting; no canvas concepts reintroduced.
