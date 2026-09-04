# Upstream PR: host-contributed side-panel tabs, driven and reported from outside

Drafted 2026-09-02 for `LodyAI/Lody`, against the vendored pin `f3474894`.
It is the contribution that lets BlitzOS drop seam patch 19 in
`vendor/lody/BLITZ-PATCHES.md`.

## Before it is opened

The same rules as `lody-surface-tabs-pr.md`, and they are not repeated in full:
an Issue a maintainer has agreed to comes first, the Context handoff is public,
an oversized PR with no Issue URL is closed after seven days, and the body is
validated with `node .github/scripts/check-pr-body.mjs --body-file <file>`.

This one is small under `git diff -w`: no hunk re-indents a block, so the raw
and whitespace-ignoring counts agree at about 150 lines, of which roughly half
are doc comments on three exported interfaces.

## Diff summary

Two files.

`packages/components/src/components/sessions/session-side-panel-tab-bar.tsx`

| Hunk | Where | What |
|---|---|---|
| 1 | `SessionSidePanelTabItem` | `kind` gains `'custom'`; adds `icon?: ReactNode` |
| 2 | `SessionSidePanelOption` | `id` gains `` `host:${string}` ``, `kind` gains `'custom'` |
| 3 | `SidePanelTabIcon` | a `'custom'` arm: the host's glyph, or `Files` |

`packages/components/src/components/sessions/session-detail.tsx`

| Hunk | Where | What |
|---|---|---|
| 4 | `type SidebarTab` | widens to carry a `host:` id; two type guards beside it |
| 5 | above the component | declares `SessionHostSidePanelTab`, `SessionSidePanelRequest`, `SessionSidePanelHostState` and one stable empty default |
| 6 | the inline props type and destructuring | three optional props, all defaulted to today's behaviour |
| 7 | beside the PR / Browser "no longer available" effects | the same effect for a withdrawn host tab |
| 8 | `sidePanelFixedOptions` | appends one `kind: 'custom'` option per host tab |
| 9 | after `handleCloseSidebarTab` | the request effect: each `seq` once, through the `+` menu's own handler |
| 10 | the `writeStoredLastActiveTabState` effect | host ids never reach persisted state |
| 11 | after `activeSidePanelTabId` | the state report, through a ref |
| 12 | `nonBrowserSidebarContent` | renders the active host tab's `content` as the panel body |

## PR title

```
feat(sessions): let a host contribute side-panel tabs, and drive the panel from outside
```

## PR body

```markdown
## Related issue

<!-- REPLACE with the full Lody Issue URL once a maintainer has agreed to this
     scope. Do not open the PR without it. -->

## Problem / pressure

The session side panel already merges three kinds of tab — the fixed panels,
side chats, and file/diff viewers — behind one strip, one `+` menu and one empty
state, and `session-detail.tsx` is careful that they stay one system
(`sidePanelTabs` is "the ONLY statement of that order"). An application that
embeds `SessionDetail` and owns a panel of its own has no way into that system:
every fixed panel is a member of a closed enum (`persistedSidePanelTabSchema`),
the handlers that open and close one are component-local, and the panel's state
is four `useState`s nothing outside can read.

So such an application either forks the page or draws a second strip somewhere
else in the layout, which a user reads as two products in one window. And if it
draws any control for the panel outside the page — an icon rail, a menu — it
cannot open a tab from there, and cannot show which one is open.

## Summary

Three optional props on `SessionDetail`, one widened kind on the side-panel tab
item. Every default is today's behaviour, and no call site in the repository
passes any of them.

```ts
/** Its id MUST start with `host:`, so it can never be mistaken for one of the
 *  persisted fixed panels and is filtered out of the persisted state. */
export interface SessionHostSidePanelTab {
  id: `host:${string}`;
  label: string;
  icon?: ReactNode;
  content: ReactNode;   // the panel body while active; not mounted otherwise
}
/** One-shot; the page handles each `seq` once, so a repeat bumps it. */
export interface SessionSidePanelRequest { tabId: string; action: 'open' | 'close'; seq: number; }
export interface SessionSidePanelHostState {
  open: boolean;
  activeTabId: string | null;
  openedTabIds: readonly string[];
  availableOptions: readonly { id: string; disabled: boolean }[];
}

hostSidePanelTabs?: readonly SessionHostSidePanelTab[];
sidePanelRequest?: SessionSidePanelRequest | null;
onSidePanelStateChange?: (state: SessionSidePanelHostState) => void;
```

A host tab is a fixed panel for every purpose but persistence. It is offered by
the `+` menu and the empty state, opened and closed by the same handlers, and
kept out of the stored side-panel state because its id can never satisfy that
enum — the `host:` prefix is checked at the type and at the filter, so a host
cannot pick an id that collides with a fixed panel and nothing that touches
persistence has to know the host's list.

A request does exactly what the `+` menu entry for the same id does, through
`handleSidePanelOptionOpen`: `'side-session'` launches a Side Chat, `'pr'` also
pushes `?pr=` into the URL, and an id the panel cannot offer right now is
ignored. The one thing added beside it is `setIsSidebarOpen(true)`, because the
menu lives inside the panel and a control outside it does not. Each `seq` is
handled once, through a ref, so the handlers may change identity without
replaying a request.

The report is an effect on the panel's derived values — `isSidebarOpen`,
`activeSidePanelTabId`, the strip's ids and the option list — with the callback
read through a ref, so a fresh host closure does not re-fire a report nothing
changed.

## Before / after

| Before | After |
| ------ | ----- |
| An embedder with a panel of its own forks `session-detail.tsx` or draws a second strip. | It passes `hostSidePanelTabs`; omitting it renders exactly what the page renders today. |
| A control for the panel outside the page cannot open a tab or learn which is open. | `sidePanelRequest` opens or closes one; `onSidePanelStateChange` reports the panel on every change. |

## Test plan

- `pnpm check` on the public tree.
- Rendered `SessionSidePanelTabBar` and `SessionSidePanelEmptyState` with a
  `custom` option: the tab draws under its `host:` id with the host's glyph (or
  `Files` with none), the empty state offers it, and select / close / open
  report the `host:` id.
- Rendered `SessionDetail` with one host tab: it appears in the `+` menu after
  PR; opening it renders its `content` in the panel body; closing it selects
  the previous sibling per the existing fallback rule; reloading the page
  restores the fixed panels and not the host tab.
- With a request `{ tabId: 'files', action: 'open', seq: 1 }` and the panel
  collapsed, the panel opens on Files; the same object re-rendered does nothing;
  `seq: 2` on a closed Files opens it again. `{ tabId: 'pr', … }` with no PR is
  ignored.
- `onSidePanelStateChange` fires on collapse, on every tab change, and when the
  option list changes (a PR appearing); it does not fire when only the callback
  identity changes.
- Rendered both with every new prop absent and confirmed the DOM is unchanged
  from `main`, and the persisted side-panel state is byte-identical.
- Not tested: mobile. `MobileSessionTabSheet` keeps its own kind enum, the
  request effect returns on `isMobile`, and the props are inert there by design.

## Decisions to challenge

- `content` mounted only while active, where the top strip's host tabs stay
  mounted. The side panel already unmounts its fixed bodies per switch, and
  Files keeps its state in `file-tree-view-state.ts` for that reason; a host tab
  gets its neighbours' rule.
- Routing a request through `handleSidePanelOptionOpen` rather than
  `activateSidebarTab`. The former is what the `+` menu does; the latter would
  skip the `?pr=` sync and the Side Chat launch.
- The `host:` prefix as a type, versus a separate `hostTabIds` set the filter
  consults. The prefix keeps the persistence filter independent of the list.

## Not done

- Mobile.
- Reordering host tabs among the fixed panels; they sort after PR, in the order
  the host gave them.
- Persisting which host tab was open. A host that wants that keeps it itself;
  it has the report.
- Keyboard shortcuts: `session.closeFocusedTab` already resolves over
  `activeSidePanelTabId`, so Cmd+W on an active host tab closes it through the
  same `handleSidePanelTabClose`; nothing else is touched.

## Context handoff

<!-- context-handoff:begin -->

### Instructions for reviewing agents

- **Review focus:** the two files above. Confirm every new prop is optional and
  defaulted, that `sidePanelFixedOptions` with no host tabs is the array it was,
  and that the persisted state cannot carry a `host:` id.
- **Decisions to challenge:** the three listed under "Decisions to challenge".
- **Plausible failures / evidence gaps:** a host tab whose id is withdrawn while
  active is cleared by hunk 7's effect but stays in `openedSidebarTabs` until the
  next filter, which is the same shape upstream already has for `browser`.

### Authoring context

- **User goal / directives:** embed `SessionDetail` in an application shell
  that owns one side panel and an icon rail for the whole side panel, and have
  both live inside the page's own panel rather than beside it.
- **Constraints / non-goals:** strictly additive; no change to default
  rendering or to persisted state; no registry, no global state, no new
  dependency.
- **Risk-bearing decisions:** none affecting data or authority — the only
  storage touched is the per-session side-panel state, which a host id never
  reaches.
- **Destructive or irreversible behavior:** none.
- **Deliberately not done or tested:** mobile, host-tab ordering, persisting
  the host selection.
- **Unknowns / confidence:** high confidence in the mechanics; the open
  question is whether maintainers want `content` mounted-while-hidden like the
  top strip's host tabs.

<!-- context-handoff:end -->
```

## When it merges

Delete seam patch 19 from `vendor/lody/BLITZ-PATCHES.md`, drop the twelve hunks
at the next `git subtree pull`, and keep passing the same three props from
`packages/webapp/src/lody/` unchanged.
