# Intro illustration direction

## Approved product role

The illustrated sequence belongs **only** to Intro. Its job is to make Lody
memorable before real configuration begins; Login, Workspace, Providers,
Projects, First Task, and Summary already communicate through their persistent
`TourStill` camera and must not receive a competing illustration layer.

The Intro is four full-screen beats. The layout never flips: copy remains on
the left, a vertical illustration remains on the right, and both cross-fade
between beats. Do not use sliding panels or a carousel-like layout change.
Only the fourth beat reveals `Configure Lody`; the first three remain readable
without a CTA. `Skip intro` may remain available.

Final 3:4 assets live in `../../assets/onboarding/intro/`:

1. `queue-current.png` — paper-current opening.
2. `quiet-work.png` — a quiet desk and continuing work.
3. `continuous-scroll.png` — one story travelling across rooms.
4. `ready-to-begin.png` — map, notebook, compass, and departure still-life.

## Illustration thinking

Use an editorial visual metaphor, not a literal description of a feature. The
copy explains Lody's product meaning; the art creates an emotionally memorable
scene. A complete little action or surreal still-life is better than a set of
icons that try to encode workspace, agent, project, device, and sync.

The successful storyboard explored this progression:

1. **The queue keeps moving** — a broad current of paper, notes, and fragments;
   Lody stays calm inside or against it.
2. **Work can keep moving** — a quiet human-scale work scene where papers or
   ideas continue their gentle motion while the person pauses.
3. **The same work continues** — one long accordion-folded scroll moves through
   two distant small rooms. It is a visual story, not a connection diagram.
4. **Prepare to begin** — Lody with a compass, map, notebook, and a composed
   pool of light: an unhurried departure still-life, not an installation flow.

These are starting motifs rather than feature specifications. Each beat must
have a clearly different viewpoint, object scale, density, and rhythm.

## Visual language

- Start from minimalist hand-drawn editorial illustration: generous cool-white
  space, an expressive action, a few distinctive objects, and slightly
  imperfect deep-navy contour lines.
- Translate that language into a premium pixel printmaking treatment: deliberate
  low-resolution edges, limited colour ramps, local dither, and fine grain.
  Pixel is a material treatment, **not** a game world or a UI style.
- Background: neutral cool white through pale blue-grey, with faint icy-aqua
  dither/grid texture. No yellow, beige, parchment, or sepia cast.
- Accents: Lody blue/teal as the richest colour; navy ink; sparse coral-orange
  marks; very occasional muted gold.
- The desired feeling is quiet, intelligent, tactile, and professional — not
  cute, childish, neon, or dark.

## Lody IP invariant

The source of truth is `../../assets/lody-icon.png`:

- rounded blue-to-teal jellyfish bell;
- six flowing tentacles;
- no face, eyes, clothes, arms, hands, or replacement creature.

Pass that source image as an explicit image-generation reference. If a model
warps the bell or tentacles, generate only the scene environment and composite
the real asset into the final illustration; do not accept a near-match.

## Rejected directions

- Literal sea-floor scenes, coral, shells, fish swarms, or cute animated Sprite
  environments.
- 3D/isometric devices, robot arms, glossy platforms, and generic game-level
  scenery.
- Node graphs, glowing data lines, device dashboards, browser-window diagrams,
  or icon networks. These are architecture diagrams, not illustrations.
- A different mascot, anthropomorphised Lody, or a distorted jellyfish.
- A one-page SaaS hero or changing left/right layout.

## Reusable image-generation prompt shape

Use this structure, then replace only the `Scene` section:

```text
Asset type: a vertical right-column editorial illustration for one full-screen
desktop onboarding Intro beat. The left half of the UI contains copy.
Input image: the supplied Lody icon is the exact IP reference. Preserve its
rounded blue-to-teal bell and six tentacles; no face, eyes, limbs, clothes, or
substitute mascot.
Scene: <one complete visual metaphor; never a product diagram>.
Style: mature minimalist hand-drawn editorial illustration translated into
premium pixel printmaking: imperfect deep-navy contour lines, controlled
low-resolution edges, limited colour ramps, local dither and fine grain.
Palette: cool white and pale blue-grey background, icy-aqua texture, Lody
blue/teal, sparse coral-orange, occasional muted gold.
Composition: a true 3:4 portrait with a distinct silhouette, generous breathing
room, and an intentional scene-specific viewpoint.
Avoid: node graphs, network lines, literal UI, 3D/isometric forms, yellow paper,
generic SaaS gradients, sea-floor decoration, kawaii/chibi treatment, text, and
watermarks.
```

The approved exploration is a four-scene 2x2 storyboard generated during this
session. It validates the **metaphorical scene approach**, not final crop or
asset dimensions; generate each final beat separately as a 3:4 portrait.
