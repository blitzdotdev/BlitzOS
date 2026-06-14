# BlitzOS native input (the general fix for the synthetic-input bug class)

Status: SPIKE, behind `BLITZ_NATIVE_INPUT=1` (default OFF). The synthetic path stays the default
until the spike is verified on a real display. Parent doc: `plans/blitzos-sandwich-compositor.md`.

## The bug class this kills

Human mouse/keyboard reaches a browser page as SYNTHETIC events: the L1 hole handlers
(`SurfaceFrame.tsx` `onHoleDown/Up/Move` + the wheel listener) forward to `os:page-input`
(`osActions.ts`), which calls `webContents.sendInputEvent(...)`. `sendInputEvent` produces
`isTrusted=false` events. That single fact is the root of a whole class:

- **B9** Cloudflare Turnstile / anti-bot checkboxes reject untrusted clicks (the reported "can't click
  the checkbox"). OAuth/user-activation gates, native double-click, middle-click also degrade.
- **B11-4** only move/down/up/wheel are forwarded: no hover enter/leave (page `:hover`/tooltips never
  clear), no HTML5 drag-and-drop, no native pinch-zoom, no scroll momentum / precise deltas.
- **B11-3** the focus handoff is a separate async clock (`os:page-focus` probes `activeElement` after
  the click), which can eat the first keystroke after clicking a field.

The agent's own control path already uses CDP `Input.dispatchMouseEvent` (trusted) and is immune;
only the HUMAN path is synthetic. The general fix: deliver the human's REAL OS input to the page.

## Mechanism (chosen: native click-through, not CDP-for-human-clicks)

L1 (UI, the renderer) is the macOS CHILD of L0 (pages); L1 is congruent and directly above L0. So a
mouse event that L1 declines falls through to L0's `WebContentsView` at the same point, as a real,
trusted NSEvent. The lever is `BrowserWindow.setIgnoreMouseEvents(true, { forward: true })`:

- `ignore:true` = the window is click-through (events pass to L0).
- `forward:true` = L1 still RECEIVES `mousemove` (so the renderer can keep tracking the cursor and
  decide when to stop ignoring), while clicks/wheel pass through.

`setIgnoreMouseEvents` is window-GLOBAL, but BlitzOS needs it ON only over a page HOLE and OFF over
opaque chrome. So toggle it per cursor move, occlusion-correct, from the renderer:

```
// App.tsx, only when window.agentOS.nativeInput
window.addEventListener('mousemove', (e) => {
  const overHole = !!document.elementFromPoint(e.clientX, e.clientY)?.closest('.webcontents-host')
  if (overHole !== last) { last = overHole; window.agentOS.nativePassthrough(overHole) }
}, true)
```

`elementFromPoint` is a geometric query independent of pointer-events, so it returns the TOPMOST
element at the cursor: an opaque widget or the radial menu sitting above a page → not over a hole →
ignore stays OFF → that UI gets the click (occlusion handled for free, which is why B11-8's global
gate was unnecessary). Because `forward:true` keeps delivering `mousemove` while ignoring, the renderer
sees the cursor leave the hole and flips ignore OFF before the next click lands on chrome.

Main applies it:

```
// index.ts
ipcMain.on('os:native-passthrough', (_e, on) => sandwich.ui.setIgnoreMouseEvents(!!on, { forward: true }))
```

When `nativeInput` is on, the L1 hole handlers (`onHoleDown/Up/Move` + wheel) become no-ops (no
synthetic send, no `pageFocus`): the real event goes to L0. Keyboard focus is then NATIVE: a click
that falls to L0 makes L0 key (OS); a click on chrome makes L1 key (helped by `acceptFirstMouse:true`,
added for B10). So the `os:page-focus` `activeElement` probe is not used in native mode (B11-3 dies
with it).

## Why not CDP-for-human-clicks

Routing the human click through the agent's CDP path is also trusted and smaller, but it keeps
`webContents.debugger` ATTACHED during all browsing, which locks the user out of DevTools and contends
with the single-client agent `surface_control`. Native click-through has neither cost and also yields
hover/drag/pinch/momentum for free. CDP stays the AGENT path.

## Unverified assumptions (REQUIRES a display; this is the spike)

1. A click on the click-through CHILD (L1) actually reaches the PARENT's (L0) `WebContentsView` as a
   trusted event (Turnstile passes). The one-way child glue (`sandwich.ts`) is about MOVING the child;
   focus/click-through is believed independent, but unverified in-repo.
2. The per-move toggle keeps up with the cursor: no chrome-click falls through, no page-click is
   missed at the hole/chrome boundary (a fast cross-then-click is the worst case).
3. L0 becoming key on a page click does not gray the UI unacceptably (the conditional handoff existed
   to avoid exactly that; native mode relies on the OS instead).
4. Native wheel passes through to L0 (scroll still works) and pinch (`ctrl`+wheel) zooms the page.

## Test checklist (run with `BLITZ_NATIVE_INPUT=1 npm run dev`)

- [ ] Cloudflare/Turnstile "verify you are human" checkbox clicks (the B9 acceptance test).
- [ ] Normal links/buttons/text-selection in a page click on the first try; typing into a page input works.
- [ ] Clicking chrome (tab strip, address bar, traffic lights, a widget over the page) still works,
      no click falls through to the page behind it.
- [ ] Page `:hover` states and tooltips appear AND clear when the cursor leaves.
- [ ] Two-finger scroll and pinch-zoom work inside the page.
- [ ] The UI chrome does not get stuck grayed-out after interacting with a page.

If 1 fails, the approach is dead and we fall back to CDP-for-human-clicks. If 2 needs hardening, add a
small dead-band / debounce or move the hit-test to main via `getCursorScreenPoint`.

## Flip to default

Once the checklist passes, make native the default (drop the flag gate), delete the synthetic
`os:page-input` mouse path (keep wheel only if native wheel proves unreliable), and remove the
`os:page-focus` probe. Then close B9, B11-3, B11-4 and revisit B11-2 (keyboard accelerators) and B11-7
(native context menu) as the remaining input-contract items.
