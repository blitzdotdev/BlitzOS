# Upstream PR: a host-resolved viewer URL for the Browser panel

Drafted 2026-09-02 for `LodyAI/Lody`, against the vendored pin `f3474894`.
It is the contribution that lets BlitzOS drop seam patch 11 in
`vendor/lody/BLITZ-PATCHES.md`.

## Before it is opened

The same rules as `lody-surface-tabs-pr.md`: an Issue a maintainer has agreed
to comes first, the Context handoff is public, an oversized PR with no Issue URL
is closed after seven days, and the body is validated with
`node .github/scripts/check-pr-body.mjs --body-file <file>`.

This one is small under `git diff -w`: no hunk re-indents a block, so the raw
and whitespace-ignoring counts agree at about 70 lines, a third of them doc
comments.

## Diff summary

Three files.

`packages/components/src/components/sessions/session-detail.tsx`

| Hunk | Where | What |
|---|---|---|
| 1 | the `@lody/shared` import | adds `type PreviewTarget` |
| 2 | the inline props type and destructuring | one optional prop |
| 3 | both `<SessionBrowserPanel>` mounts | passes it through |

`packages/components/src/components/sessions/session-browser-panel.tsx`

| Hunk | Where | What |
|---|---|---|
| 4-5 | props and destructuring | the same prop |
| 6-8 | state | `hostViewer`, reset per session and per navigation |
| 9 | `openAddress`, after the address is classified as managed and BEFORE the runtime / user guard | the host branch |
| 10 | `openAddress`'s dependency list | adds the resolver |
| 11 | the toolbar | `shareAvailable` is off in host mode |
| 12 | `<ManagedPreviewSurface>` | passes `hostViewer` |

`packages/components/src/components/sessions/managed-preview-surface.tsx`

| Hunk | Where | What |
|---|---|---|
| 13 | props | `hostViewer?: boolean`, default `false` |
| 14 | `handleIframeLoad` | no runtime handshake is armed in host mode |
| 15 | `hardReloadFrame` | the host's URL is reloaded as given |

## PR title

```
feat(sessions): let a host resolve a managed-preview target to a viewer URL of its own
```

## PR body

```markdown
## Related issue

<!-- REPLACE with the full Lody Issue URL once a maintainer has agreed to this
     scope. Do not open the PR without it. -->

## Problem / pressure

The Browser panel has strict dual engines, and `components/sessions/AGENTS.md`
is explicit that there is no fallback between them: a public host goes to the
Electron `WebContentsView`, and a loopback or private-LAN target goes to Managed
Preview — an Electron-only local endpoint, or a remote tunnel minted by the
session runtime. Both are the right engines for the two shells this repository
ships.

An application that embeds `SessionDetail` in a plain browser, against a machine
it already reaches through a gateway of its own, has neither. `openAddress`
stops at `if (!runtime || !user?.id)` — or, with a runtime, at a confirmation
dialog for a tunnel that cannot be created — and the panel is dead, although the
embedder can serve every loopback port on that machine already. The candidate an
agent reports with `lody_report_preview_candidate` therefore reaches the info
bar and goes nowhere.

## Summary

One optional prop, threaded from `SessionDetail` through `SessionBrowserPanel`
to `ManagedPreviewSurface`. With it absent every branch is the one taken today,
and no call site in the repository passes it.

```ts
/** Answer a loopback or private-LAN Browser target with a viewer URL of the
 *  host's own, or `null` to let the panel resolve it as it does today. */
resolveManagedPreviewViewerUrl?: (target: PreviewTarget) => string | null;
```

The host's answer is asked for in `openAddress` after the address has been
classified as managed and BEFORE the runtime and the user are required, because
a host that serves the page needs neither. Every navigation path lands there:
the address bar, Back / Forward through `navigateHistory`, the auto-restore
effect, the candidate click, and a reload after the endpoint is gone. The panel
then commits the address with the host's URL as `viewerUrl`, and the iframe it
already has loads it.

Two things follow from "the page is the host's", and each is one hunk:

- **The URL is loaded as given.** `hardReloadFrame` rebuilds the frame's `src`
  from the logical URL's root-relative path, carrying only the capability
  params over. A host's URL may carry a prefix that is neither, so in host mode
  the reload uses `viewerUrl` verbatim. (The frame cache already sets `src`
  from `viewerUrl` as given and needs no change.)
- **No annotation runtime is expected.** `handleIframeLoad` arms a timer that
  reports the runtime's absence as an error three seconds after every load. A
  host-served page has none, so annotation is simply unavailable and the timer
  is not armed. `runtimeAliveRef` stays `false`, so `reload` takes the
  hard-reload path rather than a postMessage nothing answers.

Share is off in host mode: it would mint a tunnel for a page the host is
already serving.

## Before / after

| Before | After |
| ------ | ----- |
| In a non-Electron embedding with no cloud, a loopback target ends at "The session runtime is unavailable" and the Browser panel cannot open anything. | The host answers the target with a URL it serves; the panel opens it, keeps its own history, and reloads it verbatim. |
| — | With the prop absent, nothing changes: `hostViewerUrl` is `null` on every navigation and every branch is today's. |

## Test plan

- `pnpm check` on the public tree.
- Rendered `SessionBrowserPanel` with the prop returning an absolute URL for
  `localhost:3000`: typing that address opens it without a runtime and without
  a user; the iframe's `src` is the host's URL; Back / Forward walk the panel's
  own history; Reload sets `src` to the same URL again; no error appears after
  three seconds; the annotation and Share controls are unavailable.
- The prop returning `null`: the panel behaves exactly as on `main`, including
  the runtime-unavailable error and the tunnel confirmation.
- A public address with the prop present: `public-web`, the prop is not asked.
- Rendered all three with the prop absent and confirmed the DOM is unchanged
  from `main`.

## Decisions to challenge

- A resolver prop versus a platform capability (`PLATFORM_CAPABILITIES`). A
  capability would say "the host can serve previews" but not how; the URL has
  to come from somewhere, and a function is the smallest thing that can carry
  it.
- Whether the host branch should sit after the machine-plane resolution
  instead. It sits before it because the plane is Electron-only knowledge and
  the host branch must work without a runtime.
- Whether `previewOrigin` should resolve a relative URL against the document.
  Left as is; the prop's doc comment requires an absolute URL.

## Not done

- Visual annotation and preview comments in host mode; both need the injected
  runtime, and injecting it is the host's problem, not this prop's.
- A host-mode Share. The host has its own way to share what it serves.
- Mobile is passed the prop and not otherwise changed.

## Context handoff

<!-- context-handoff:begin -->

### Instructions for reviewing agents

- **Review focus:** the three files above. Confirm the prop is optional and
  defaulted, that the host branch runs before the runtime / user guard and
  after the managed classification, and that `hostViewer` is reset at the top
  of every navigation and every session switch.
- **Decisions to challenge:** the three listed under "Decisions to challenge".
- **Plausible failures / evidence gaps:** a host URL on a different origin from
  the app is fine for the frame but the `message` listener compares
  `event.origin` to it, so a host that DOES inject the runtime must serve it
  from that origin; not exercised here.

### Authoring context

- **User goal / directives:** embed `SessionDetail` in a plain browser against
  a machine the embedder reaches through its own gateway, and have the Browser
  panel open the agent's reported dev server through that gateway.
- **Constraints / non-goals:** strictly additive; no change to default
  behaviour; no new engine, no fallback between the existing engines.
- **Risk-bearing decisions:** none affecting data or authority — the host
  decides what URL to serve, the panel only loads it.
- **Destructive or irreversible behavior:** none.
- **Deliberately not done or tested:** annotation, Share, mobile.
- **Unknowns / confidence:** high confidence in the mechanics; the open
  question is a prop versus a capability.

<!-- context-handoff:end -->
```

## When it merges

Delete seam patch 11 from `vendor/lody/BLITZ-PATCHES.md`, drop the fifteen
hunks at the next `git subtree pull`, and keep passing the same resolver from
`packages/webapp/src/lody/` unchanged.
