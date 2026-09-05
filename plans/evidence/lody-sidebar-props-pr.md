# Upstream PR: `LoroSidebar` header/footer suppression props

> **Dated upstream-PR sketch.** As of 2026-09-04, execute any resulting subtree
> update through `docs/LODY-MERGE.md`; merge mechanics below are historical.

Drafted 2026-08-30 for `LodyAI/Lody`, against the vendored pin `966623d0`.
It is the contribution that lets BlitzOS drop seam patch 2 in
`vendor/lody/BLITZ-PATCHES.md` (`plans/LODY-SESSIONS.md` §0.3, §5.3 item 4).

## Before it is opened

Their `.github/AGENTS.md` is explicit and the cost is real, so it is written
down here rather than discovered at submission time:

1. **An Issue must exist and a maintainer must agree first.** Creating the
   Issue is not approval. The PR links the full Issue URL under
   `## Related issue`, and implementation is supposed to wait for explicit
   maintainer agreement on scope and approach. This patch was written ahead of
   that agreement because BlitzOS needs the rail now; the PR body must not
   claim notice or agreement that did not happen.
2. **The Context handoff is public.** No transcripts, no secrets, no `N/A`.
3. **An invalid body is closed after seven days**, and so is an oversized PR
   (>200 changed lines) with no Issue URL. This change is 23 lines with
   `git diff -w` and ~170 without, because two hunks re-indent the blocks they
   wrap — so it needs the Issue URL either way, and the body should say that
   the re-indent is the bulk.
4. Validate before opening:
   `node .github/scripts/check-pr-body.mjs --body-file <file>`.
5. Their commit convention: `feat: …`, and AI commits end with
   `Model: <runtime-model-id>`.

## Diff summary

One file, `packages/components/src/components/loro-sidebar.tsx`.

| Hunk | Where | What |
|---|---|---|
| 1 | `LoroSidebarProps`, after `bottomFloatingContent` | declares `hideHeader?: boolean` and `hideFooter?: boolean` with doc comments |
| 2 | the component's destructuring, after `bottomFloatingContent,` | `hideHeader = false, hideFooter = false` |
| 3 | the `group/sidebar-header` block | `{hideHeader ? null : ( … )}` |
| 4 | the `getLoroSidebarFooterClassName(isMobile)` block | `{hideFooter ? null : ( … )}` |

23 lines under `git diff -w`, 15 of them the two doc comments. No call site in
the repository passes either prop, so rendering is unchanged everywhere.

## PR title

```
feat(components): let a host suppress LoroSidebar's own header and footer
```

## PR body

```markdown
## Related issue

<!-- REPLACE with the full Lody Issue URL once a maintainer has agreed to this
     scope. Do not open the PR without it: this change is over 200 raw lines. -->

## Problem / pressure

`LoroSidebar` is written to be embeddable — it is pure, props-driven, and it
already exposes `topContent`, `afterSessionListContent` and
`bottomFloatingContent` for a host to fill. But it always draws two pieces of
chrome a host cannot opt out of: the workspace-identity header row (switcher or
nameplate, plus the collapse button) and the footer utility rail (settings,
help, archive, and on mobile the filter popover).

An application that embeds the sidebar BODY inside an existing shell already has
its own workspace header and its own settings entry. Today it renders two of
each. There is no prop, no slot and no class that removes either, so the only
options are a source patch or a fork of the component — both of which mean the
embedder stops tracking upstream.

## Summary

Adds two optional booleans, `hideHeader` and `hideFooter`, both defaulting to
`false`. Each guards exactly one existing block with a `? null :`. Nothing else
changes: no new element, no new class, no reordering, no behaviour behind either
flag other than not rendering the block it names.

The doc comment on `hideFooter` records the one consequence a host has to accept:
on mobile the footer is the only place `SidebarFilterPopover` renders, so a host
that hides it owns the organize/scope control.

## Before / after

| Before | After |
| ------ | ----- |
| An embedder mounting the sidebar body inside its own shell renders two workspace headers and two settings entries. | `hideHeader` / `hideFooter` suppress the blocks the host already serves; omitting both renders exactly what it renders today. |

## Test plan

- `pnpm check` on the public tree.
- Rendered the component with `hideHeader hideFooter` and asserted the absence
  of `[data-workspace-switcher-trigger]`, `[data-workspace-identity]` and the
  Settings / Help / Archive icon buttons, while `topContent`,
  `sessionListProps` and `afterSessionListContent` still render.
- Rendered it with neither prop and confirmed the DOM is unchanged from `main`.
- Not tested: mobile layout with `hideFooter` set, because the intended host
  supplies no organize/scope control at all; the prop's doc comment states that
  responsibility rather than the code assuming it.

## Context handoff

<!-- context-handoff:begin -->

### Instructions for reviewing agents

- **Review focus:** `packages/components/src/components/loro-sidebar.tsx` only —
  confirm hunks 3 and 4 wrap the existing blocks unchanged and that the large
  raw diff is re-indentation (`git diff -w` shows 23 lines).
- **Decisions to challenge:** two booleans versus one `chrome` prop or nullable
  slots; and whether hiding the footer should keep the mobile filter trigger
  somewhere rather than dropping it.
- **Plausible failures / evidence gaps:** a mobile host that sets `hideFooter`
  loses the only organize/scope control, which is documented but not enforced;
  no Storybook story was added for the suppressed state.

### Authoring context

- **User goal / directives:** mount the sidebar body inside an existing
  application shell that already draws its own workspace header and settings
  entry, without forking the component.
- **Constraints / non-goals:** strictly additive; no change to default
  rendering, no new styling hook, and no attempt to make the header or footer
  configurable beyond present/absent.
- **Risk-bearing decisions:** none affecting data or authority — the change is
  render-only and both props default to today's behaviour.
- **Destructive or irreversible behavior:** none; nothing is migrated, written
  or deleted.
- **Deliberately not done or tested:** no Storybook story for the suppressed
  state, and no mobile substitute for the filter trigger the footer carries.
- **Unknowns / confidence:** high confidence in the mechanics; the open question
  is whether maintainers prefer a different prop shape for the same capability.

<!-- context-handoff:end -->
```

## When it merges

Delete seam patch 2 from `vendor/lody/BLITZ-PATCHES.md`, drop the four hunks at
the next `git subtree pull`, and keep passing `hideHeader` / `hideFooter` from
`packages/webapp/src/lody/SessionRailSidebar.tsx` unchanged — the props are the
same either way, which is the point of upstreaming rather than patching.
