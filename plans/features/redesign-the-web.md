# Redesign the web: BlitzOS rewrites any site into what the user actually wants

**Status:** vision (2026-06-09). Expands the "redesign any website" backlog line (`agent-os-desktop-architecture.md` section 6) into the full ambition.
**Companions:** `dynamic-provider-substrate.md` (the `provider.call` last-hop primitive), `confidential-ai-gateway.md` (the gateway + inference layer), `session-tape-and-daydreaming.md` (the personal corpus that makes the rewrite personal).

## The idea in one line
BlitzOS does not just show you the web. It rewrites the web on the fly into whatever serves you best. Point it at any URL and the page becomes what it should have been.

## The spectrum, least to most ambitious
1. **Subtract.** Kill the slop. An unwanted feature pops up in Google Docs, an AI chat bar nobody asked for. Say "get rid of it" and it is gone. The OS reads the page and re-renders it without the cruft.
2. **Re-paradigm.** Same data, a better interface. X.com as Instagram. X.com as Snapchat. YouTube as TikTok. The underlying account and content are unchanged; the OS presents them in the UX paradigm the user actually wants. The basic ones go viral on their own.
3. **Gamify and adapt.** The boring obligation becomes a game that completes the obligation. A dreadfully boring school Canvas portal for classes and assignments turns into a tech-tree-driven strategy game with genuinely fun exercises that, when solved, do the real assignment for you. The AI building it is steered live, so it adapts on the fly to keep the entertainment up.
4. **Generate.** Whole experiences with no original site to lean on. Roleplay experiences, multi-turn games, "video streams" constructed entirely of agent tool calls, where every decision the user makes curates an experience that is deeply emotional and compelling.

## The substrate that makes it possible (and a moat)
This is not a browser extension. It needs the whole agent OS, because a rewrite has to *act on the real site underneath*, not just repaint it.
- **`web` surface + `read_window` / CDP:** read the original's content, structure, and live state.
- **Authoring (`srcdoc` / blitz.dev):** render the rewrite as a real surface on the canvas, in the BlitzOS design language.
- **`provider_call` + `surface_control`:** drive the real site beneath the rewrite, so it stays *functional*, not cosmetic. The tech-tree game submits the actual assignment. The Snapchat skin posts the real tweet. A pretty screenshot that does not act is worthless; this is the hard, defensible part.
- **The AI gateway as first-class tool calls:** any text converted into an image on demand, then video, audio, 3D. This is the generative engine for modes 3 and 4. Subsidized at our cost for a free trial, then plug a card in for a world of fun. (Built on `dynamic-provider-substrate.md` / `confidential-ai-gateway.md`.)
- **The autonomy loop + personal corpus:** the rewrite adapts to the user in real time. The builder AI reads their engagement and re-steers to keep it fun, and the corpus (`session-tape-and-daydreaming.md`) makes it personal, not generic.

## The hard parts (worth solving on purpose)
- **Functional rewrites.** Keeping the generated UI wired to the real site (submit, post, complete) is the whole game. This is why it needs the OS.
- **Structure extraction.** DOM vs readable text vs screenshot-plus-vision, and how much to lift before re-rendering.
- **The fun feedback loop.** How the builder AI reads engagement and re-steers (the Canvas game staying fun across a whole semester).
- **Generative cost and latency.** Text-to-image and text-to-video on demand have to feel instant and be paid for. The subsidized-then-card model is the lever.
- **Trust and the real-vs-generated boundary.** When a generated UI acts on the user's real accounts, the approval rails and a clear "this is real, this is generated" line are non-negotiable.

## Why it goes viral and why it is next level
The basic re-skins (X as Instagram, YouTube as TikTok) go viral by themselves. But the product is the long tail: every boring, ugly, or hostile corner of the web becomes a personal, fun, emotionally compelling experience that still does the underlying job. Nobody else can ship this, because it needs the OS (read and act on any site) plus the gateway (generate any media) plus the canvas (render anything) plus the corpus (make it personal), all at once.

## Open decisions
- **Gateway monetization mechanics:** free-trial limits, per-call vs subscription, exactly what we subsidize and for how long.
- **Functional-rewrite safety:** acting on real accounts through a generated UI runs on the existing approval rails; design the real-vs-generated boundary explicitly.
- **First flagship demo:** the Canvas-portal-as-tech-tree-game is the strongest "next level" proof; the X / YouTube re-skins are the strongest "goes viral" proof. Pick which to build first.

<TODO>
Which flagship to prototype first, and how far to take the gateway billing in v1. The Canvas game proves
the depth (functional + adaptive + generative, all at once) but is the hardest. The X/YouTube re-skins
prove the virality and are far cheaper. Your call on lead demo, and whether v1 ships the paid gateway
tool calls or stays fully subsidized to start.
</TODO>
