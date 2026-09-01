# Upstream PR: a read-only session surface

Drafted 2026-08-30 for `LodyAI/Lody`, against the vendored pin `966623d0`.
It is the contribution that lets BlitzOS drop seam patch 4 in
`vendor/lody/BLITZ-PATCHES.md` (`plans/LODY-SHARING.md` §10.4).

## Before it is opened

Their `.github/AGENTS.md` applies unchanged, and the four costs seam patch 2's
sketch lists are the same here (`plans/evidence/lody-sidebar-props-pr.md`): an
Issue must exist and a maintainer must agree first, the Context handoff is
public, an invalid body is closed after seven days, and the body is validated
with `node .github/scripts/check-pr-body.mjs --body-file <file>`. Their commit
convention is `feat: …`, and AI commits end with `Model: <runtime-model-id>`.

The meaningful diff is four hunks, so the oversize rule does not bite; the Issue
URL is still required by the template.

## Diff summary

Two files, two props of the shape `SessionChatInterface` already uses.

`packages/components/src/components/sessions/session-chat-interface.tsx`:

```diff
   /** When true, hide the message area and input but keep the header and subHeader visible */
   hideMessageArea?: boolean;
+  /**
+   * When true, this surface follows the session without driving it: the
+   * composer and the permission request's response buttons are not rendered.
+   */
+  readOnly?: boolean;
```

```diff
       hideMessageArea = false,
+      readOnly = false,
       syncEnabled = !hideMessageArea,
```

```diff
-                  {shouldReplaceComposerWithPermission ? null : (
+                  {readOnly || shouldReplaceComposerWithPermission ? null : (
                     <SessionChatInputArea
```

```diff
-                  <FloatingPermissionRequest … />
+                  {readOnly ? null : (
+                    <FloatingPermissionRequest … />
+                  )}
```

`packages/components/src/components/sessions/session-detail.tsx` declares the
same prop, defaults it to `false`, and passes it to the `SessionChatInterface`
that renders a session tab. The `headerVariant="toolbar"` instance is not passed
it: that one carries `hideMessageArea`, so it renders neither control, and
passing a prop that selects nothing would suggest it did.

## The argument

Lody's model today is that a workspace member who can see a session can drive it.
That is the right default for a team on one machine, and it is what makes
`SessionChatInterface` simple. It leaves no way to mount a session for somebody
who may read it and not write it — and there are at least three hosts that want
one:

1. **A shared session across machines.** A session runs on one member's machine;
   another member may follow it. Whether the relay applies their writes is the
   host's business, but the composer should not offer a control whose result is
   discarded.
2. **The code-review viewer.** `code-review-viewer` renders a conversation for a
   reader who is not the author. It builds its own surface today.
3. **An archived session.** `isArchivedSession` already suppresses sending, but
   it does it by threading one boolean through nine places inside the component.
   `readOnly` is the same idea named once.

The prop is presentation only, and the doc comment says so: a viewer who cannot
write is enforced wherever the writes are applied, never in a React component.
What it buys is that a control which cannot work is not drawn.

It follows the conventions the file already has. `hideHeader`, `hideMessageArea`
and `isVisible` are the same shape — optional booleans, defaulted in the
destructuring, read at one or two render sites — and `readOnly` reads at two.

## What it deliberately does not cover

The header's "…" menu still offers archive, delete, rename and fork. Those act
through `useSessionActions` rather than through this component's own render, and
widening the prop to reach them means threading it through
`headerVariant="toolbar"`'s separate instance. It is a fair follow-up; it is not
this PR, because the composer and the permission card are the two controls a
viewer reaches by accident.

## Alternatives considered

- **A host-side CSS rule hiding the composer.** No selector exists to hang it
  on: the composer's shell class is computed by
  `getSessionChatInputAreaShellClassName` out of tailwind utilities, so a rule
  would key off layout position and break silently at the next refactor.
- **Reusing `isArchivedSession` or `isMachineRemoved`.** Both change header copy
  as well as the composer, and both would state something untrue about the
  session.
- **A `canWrite` capability on the session document.** Larger, and it decides who
  a viewer is — which is exactly the part a host should own.

## Test note

Their `AGENTS.md` requires assertions at the lowest realistic boundary and no
wall-clock dependence. The natural test is a Storybook story or a component test
that mounts `SessionChatInterface` twice over the same session document and
asserts the composer's textarea is present in one and absent in the other.
