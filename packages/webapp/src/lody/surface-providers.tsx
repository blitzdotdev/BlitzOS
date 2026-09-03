/**
 * The surface's provider stack, in the order design doc §1.4 fixes: i18n, the
 * per-surface i18n/tooltips and the active surface's toast host. The root theme
 * owner is separate because it is page-global, not runtime/store state.
 *
 * ITS OWN MODULE, for the reason `shell-theme.tsx` gives about itself. Mounting
 * `SessionSurface` in a test costs the whole vendored renderer — Monaco, shiki,
 * three, the Loro WASM — so the only harness that ever mounted the real stack
 * was the daemon-backed one, which skips wherever a `lody` daemon is not
 * installed, which is CI. Everything here imports their i18n, their theme
 * provider, their tooltip provider, their toaster and nothing else, so the whole
 * stack can be mounted for the price of `next-themes` and `sonner`.
 *
 * `SessionSurface.tsx` re-exports it, because that is the file every reader
 * comes to first and the stack is still its composition.
 */
import { useMemo, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { TooltipProvider } from "@lody/components/ui/tooltip";
import { Toaster } from "@lody/components/ui/sonner";
import { initLodyI18n } from "./i18n.js";
import { BlitzThemedLodyTree, adoptShellTheme } from "./shell-theme.js";
import { seedWorktreeWorkdirDefault } from "./workdir-default.js";

/**
 * THE TOASTER IS PART OF THE STACK, and leaving it out cost the surface every
 * error it reports (wave 4, C1). Around ninety `toast.*` call sites in the
 * vendored session components are the ONLY report a member gets for a failed
 * fork, a refused rename, a side chat that cannot be closed, a copy that did not
 * happen. Sonner renders nothing without a mounted `<Toaster/>`, and a
 * real-Chromium audit of the live surface found `[data-sonner-toaster]` absent:
 * every one of those calls was swallowed, so the surface answered a failed
 * action by doing nothing at all.
 *
 * IT IS THEIR COMPONENT, WITH THEIR PROPS. `routes/__root.tsx:12,216` mounts
 * `<Toaster />` from `@/ui/sonner` with no props, so this is the same import and
 * the same element: an upstream change to the toast chrome reaches us for free
 * and a merge has nothing to reconcile.
 *
 * IT SITS INSIDE `BlitzThemedLodyTree` BECAUSE IT READS THE THEME. Their wrapper
 * calls `useResolvedTheme()` (`ui/sonner.tsx`) and hands Sonner the RESOLVED
 * light/dark rather than letting it re-derive one from `prefers-color-scheme`;
 * that hook is next-themes', so the element has to sit below the provider
 * `ShellThemeBridge` keeps on the shell's choice. Its colours resolve through
 * `hsl(var(--popover))` and friends, which the generated Blitz sheet declares on
 * `.lody-surface` — and Sonner renders in place rather than through a portal, so
 * it inherits them from the surface it lives in.
 *
 * IT CANNOT DOUBLE-MOUNT, and two toasters would show every toast twice. There
 * are exactly two ways to get one: this stack, and upstream's `__root.tsx`. That
 * root route is not in our route tree and cannot be — `createLodySessionRouter`
 * builds its own `createRootRoute` (`router.tsx`) and mounts their PAGES, never
 * their roots — and `LodySessionsRegion` renders ONE `SessionSurface`, swapping
 * between the workspace's own box and a shared one by `key` rather than mounting
 * both.
 *
 * THE WRAPPER IS OURS AND THE ELEMENT INSIDE IT IS THEIRS. Sonner's live region
 * is an empty `<section>` — every toast in it is `position: fixed` — and
 * `.lody-surface > *` hands every child `flex: 1 1 auto`, which would give that
 * nothing a share of the surface's height. `.lody-surface__toaster` is the same
 * shape of exception `.lody-surface__auth-notice` already is, on a class we own
 * rather than on Sonner's markup.
 */
export const LODY_TOASTER_HOST_CLASS = "lody-surface__toaster";

/**
 * One page-global Lody theme owner around every surface slot.
 *
 * The provider reads no Jotai store or workspace runtime. Hoisting it keeps an
 * inactive or evicted surface's VS Code-theme cleanup from clearing root CSS
 * state installed by the active surface.
 */
export function LodySurfaceThemeRoot(props: { children: ReactNode }) {
  const theme = useMemo(() => adoptShellTheme(), []);
  return <BlitzThemedLodyTree theme={theme}>{props.children}</BlitzThemedLodyTree>;
}

export function LodySurfaceToaster() {
  return <div className={LODY_TOASTER_HOST_CLASS}><Toaster /></div>;
}

export function LodySurfaceProviders(props: { children: ReactNode; active?: boolean }) {
  const i18n = useMemo(() => initLodyI18n(), []);
  // This writes a key vendored code reads on first render, so it must happen
  // before that render just like the hoisted root's theme adoption.
  useMemo(() => seedWorktreeWorkdirDefault(), []);
  return (
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>{props.children}</TooltipProvider>
      {props.active !== false && <LodySurfaceToaster />}
    </I18nextProvider>
  );
}
