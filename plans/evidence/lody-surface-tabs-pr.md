# Upstream PR: host-contributed tabs in the session tab strip

> **Dated upstream-PR sketch.** As of 2026-09-04, execute any resulting subtree
> update through `docs/LODY-MERGE.md`; merge mechanics below are historical.

Drafted 2026-08-31 for `LodyAI/Lody`, against the vendored pin `f3474894`.
It is the contribution that lets BlitzOS drop seam patch 5 in
`vendor/lody/BLITZ-PATCHES.md` (`plans/LODY-TERMINAL-TABS.md` §3.3).

## Before it is opened

Their `.github/AGENTS.md` is explicit and the cost is real, so it is written
down here rather than discovered at submission time:

1. **An Issue must exist and a maintainer must agree first.** Creating the
   Issue is not approval. The PR links the full Issue URL under
   `## Related issue`, and implementation is supposed to wait for explicit
   maintainer agreement on scope and approach. This patch was written ahead of
   that agreement because BlitzOS needs one tab strip now; the PR body must not
   claim notice or agreement that did not happen.
2. **The Context handoff is public.** No transcripts, no secrets, no `N/A`.
3. **An invalid body is closed after seven days**, and so is an oversized PR
   (>200 changed lines) with no Issue URL. This one is small under
   `git diff -w`: no hunk re-indents a block, so the raw and whitespace-ignoring
   counts agree at about 100 lines, roughly half of them doc comments.
4. Validate before opening:
   `node .github/scripts/check-pr-body.mjs --body-file <file>`.
5. Their commit convention: `feat: …`, and AI commits end with
   `Model: <runtime-model-id>`.

## Diff summary

Two files.

`packages/components/src/components/sessions/session-tab-bar.tsx`

| Hunk | Where | What |
|---|---|---|
| 1 | the `react` import | adds `type ReactNode` |
| 2 | `ViewerTabItem` | `type` gains `'custom'`; adds `icon?: ReactNode` |
| 3 | `ViewerTabContent`'s glyph `<span>` | draws `tab.icon` when one was supplied |
| 4 | `SessionTabBarProps` | `parentSession` becomes optional |
| 5 | `visibleTabIds` | reads the parent id only when `showSessionTabs` and a session was given |
| 6 | the parent `AdaptiveTabStripItem` | the existing `showSessionTabs &&` guard gains `parentSession &&` |

`packages/components/src/components/sessions/session-detail.tsx`

| Hunk | Where | What |
|---|---|---|
| 7 | the `react` import | adds `type ReactNode` |
| 8 | above the component | declares `SessionSurfaceTab` and one stable empty default |
| 9 | the inline props type and destructuring | five optional props, all defaulted to today's behaviour |
| 10 | before `tabBar` | maps the host's tabs to `ViewerTabItem[]`, memoized |
| 11 | the `SessionTabBar` element | `variant` becomes `'mixed'` only when the host contributed a tab |
| 12 | the same element | passes the four viewer-tab props through |
| 13-14 | `desktopChatSurfaces` | an active host tab deselects the conversation surfaces |
| 15 | the end of `desktopChatSurfaces` | mounts each host tab's content, hidden when inactive |
| 16 | the inline props type | declares `onSessionTabSelect` |
| 17-18 | the `activeTabSessionId` state | the setter becomes the one place a conversation-tab selection is announced |
| 19-20 | the props type and the `not-found` effect | declares `onSessionMissing` and calls it when the page returns above the strip |

## PR title

```
feat(sessions): let a host contribute tabs to the session tab strip
```

## PR body

```markdown
## Related issue

<!-- REPLACE with the full Lody Issue URL once a maintainer has agreed to this
     scope. Do not open the PR without it. -->

## Problem / pressure

`SessionTabBar` is already props-driven and already carries a non-session tab
channel: `viewerTabs`, `activeViewerTabId`, `onViewerTabSelect`,
`onViewerTabClose`, and the `viewer` arm of `SortableItemData` are all
implemented. But `SessionDetail` is the only production caller and it passes
`variant="session"` and no viewer tabs at all, so an embedder that wants one
more tab beside the conversation has to fork the page.

`variant="viewer"` has the same shape of problem from the other side: the
variant exists, it tells the strip to draw no session tabs — and `parentSession`
is a required prop, so a host that has no session cannot use the variant that
was written for exactly that case.

The concrete pressure is an application that embeds `SessionDetail` and owns a
surface of its own that belongs beside the conversation. Today the only way to
show it is a second tab strip somewhere else in the layout, which reads to a
user as two products in one window.

## Summary

Five optional props on `SessionDetail`, one optional prop and one widened union
member on `SessionTabBar`. Every default is today's behaviour, and no call site
in the repository passes any of them.

```ts
export interface SessionSurfaceTab {
  id: string;         // unique across this strip; must not collide with a session id
  label: string;
  icon?: ReactNode;
  content: ReactNode; // mounted always, hidden when another tab is active
}

surfaceTabs?: readonly SessionSurfaceTab[];
activeSurfaceTabId?: string | null;
onSurfaceTabSelect?: (tabId: string) => void;
onSurfaceTabClose?: (tabId: string) => void;
/** This page selected a CONVERSATION tab, so no host tab is selected now. */
onSessionTabSelect?: (tabId: string) => void;
/** This page has no session to draw, so it returns above the strip and the
 *  host's tabs go with it. */
onSessionMissing?: (sessionId: string) => void;
```

The host owns the list, the selection and both verbs; the page owns the drawing
and the layout. There is no registry, no atom and no context, because there is
no extension mechanism in the tree to hook into and this is the smallest thing
that could be one.

`onSessionMissing` is the sixth, and it is the other thing the host cannot see.
`SessionDetail` renders `SessionNotFound` and returns ABOVE the tab strip, so
every host tab disappears with it — including the one the user is looking at,
whose content may be a live process the host owns. Without the callback the host
is holding a selection in a strip that is not on screen and has no way to learn
it. It fires from inside the existing `sessionPresenceState === 'not-found'`
effect, above the once-per-session analytics guard, because what a host does
with it is move an address and an address can come back.

`onSessionTabSelect` is the fifth, and it is what makes the other four
survivable. An active host tab hides the conversation surfaces, and the page's
own tab selection is `useState` that nothing outside can read — so a host that
is never told about a conversation click keeps its tab selected and keeps
covering the conversation the user asked for.

It is announced from the SETTER, not from the strip's click handler. Ten call
sites move that state — the strip click, the `+`, a close, a restore, a fork, a
mention navigation, the next/previous cycle, a promoted draft, the browser
panel, and the URL sync — and a host that hears only about the click gets the
same defect one button along: the `+` creates a draft tab that opens underneath
the host tab and never appears. The three writers that take the raw setter are
corrections rather than selections (the session-switch reset, which runs during
render, and the two `?tab=` syncs), and they are the three that pass an updater
rather than an id.

An effect on the value would not do: it fires on a CHANGE, and the click that
most needs the call changes nothing — the parent tab is already
`activeTabSessionId` while a host tab covers it.

`parentSession` becoming optional is the second half, and it is what makes the
already-declared `variant="viewer"` usable by a host that has no session to root
a strip in.

## Before / after

| Before | After |
| ------ | ----- |
| An embedder that wants one more tab beside the conversation forks `session-detail.tsx`, or draws a second tab strip the user reads as a second product. | It passes `surfaceTabs` and two callbacks; omitting them renders exactly what the page renders today. |
| `variant="viewer"` is declared and cannot be used: it draws no session tabs and still requires `parentSession`. | A host may mount the strip with the variant it was given. |

## Test plan

- `pnpm check` on the public tree.
- Rendered `SessionTabBar` with `variant="viewer"`, no `parentSession`, and
  three custom tabs: the tabs draw, select and close, and the parent tab is
  absent.
- Rendered `SessionDetail` with two `surfaceTabs`: the tabs appear in the strip
  after the session tabs; selecting one calls `onSurfaceTabSelect` with its id
  and hides the conversation surfaces without unmounting them; the tab's own
  content is in the DOM and merely `hidden` while another tab is active.
- With a host tab active, clicking the parent session tab calls
  `onSessionTabSelect` with the parent id — including when `activeTabSessionId`
  was already that id, which is the case a change-detecting notification misses.
- With a host tab active, the strip's `+` calls `onSessionTabSelect` with the new
  draft's id, and the next/previous tab shortcut calls it with the tab it moved
  to. Both go through the same setter as the click.
- Rendered both with every new prop absent and confirmed the DOM is unchanged
  from `main`.
- Not tested: mobile. `MobileSessionTabSheet` keeps its own kind enum and the
  props are inert there by design.

## Decisions to challenge

- `content: ReactNode` versus a render prop keyed by id. A ref-callback portal
  host was tried first and dropped: React remounts a portal whose container
  identity changes, so it does not buy the stability it looks like it buys.
- `type: 'custom'` on `ViewerTabItem` versus a fourth arm on `SortableItemData`.
  The fourth arm is arguably cleaner and is a bigger diff.
- Whether `parentSession` should become optional, or `variant="viewer"` should
  be removed instead as dead API.

## Not done

- Mobile: `MobileSessionTabSheet` keeps its own hand-maintained kind enum.
- DnD reorder across host tabs. Host tabs sort after the session tabs and do not
  drag; `tabOrder` is persisted per session in localStorage and a host's order
  usually is not.
- Keyboard shortcuts: `getSessionTabCloseTarget`
  (`lib/session-tab-close-target.ts:8`) still resolves Cmd+W to a conversation
  or side-panel tab, and is not patched. `session.archiveCurrent`,
  `session.closeFocusedTab` and the `session.nextTab` / `session.previousTab`
  cycle likewise resolve against `activeTabSessionId` alone, so with a host tab
  active they act on the conversation behind it. Resolving all of them over the
  same `viewerTabs` the strip already draws is the obvious follow-up and is one
  idea with this patch, not part of it.
- The loading branch. `SessionDetail` also returns above the strip while the
  session loads, and that one is transient, so a host that hides its tabs for it
  would flicker. Only the terminal branch is reported.

## Context handoff

<!-- context-handoff:begin -->

### Instructions for reviewing agents

- **Review focus:** the two files above. Confirm every new prop is optional and
  defaulted, that `surfaceTabs.length === 0` keeps `variant="session"`, and that
  the `parentSession` guards are the only places the prop is read.
- **Decisions to challenge:** the three listed under "Decisions to challenge".
- **Plausible failures / evidence gaps:** `variant="mixed"` gates
  `hasActiveViewerTab`, so a session that HAS host tabs takes a code path a
  session without them does not; the added assertions cover the empty case and
  the non-empty case but not every combination with real file/diff viewer tabs
  open at the same time.

### Authoring context

- **User goal / directives:** embed `SessionDetail` in an application shell that
  owns one more surface, and show it as a tab of the same strip rather than as a
  second strip.
- **Constraints / non-goals:** strictly additive; no change to default
  rendering; no registry, no global state, no new dependency.
- **Risk-bearing decisions:** none affecting data or authority — the change is
  render-only and every prop defaults to today's behaviour.
- **Destructive or irreversible behavior:** none; nothing is migrated, written
  or deleted.
- **Deliberately not done or tested:** mobile, DnD across host tabs, Cmd+W.
- **Unknowns / confidence:** high confidence in the mechanics; the open question
  is whether maintainers prefer a fourth `SortableItemData` arm to a widened
  `ViewerTabItem`.

<!-- context-handoff:end -->
```

## When it merges

Delete seam patch 5 from `vendor/lody/BLITZ-PATCHES.md`, drop the twenty hunks
at the next `git subtree pull`, and keep passing the same six props from
`packages/webapp/src/lody/router.tsx` unchanged — the BlitzOS half is the same
either way, which is the point of upstreaming rather than patching.
