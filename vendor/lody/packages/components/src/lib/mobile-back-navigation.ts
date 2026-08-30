/**
 * Single-shot module-level flag that suppresses the iOS-style "slide
 * in from the right" enter animation on the *next* mount of a mobile
 * detail layout, so we don't replay a forward-push animation on a
 * back-pop navigation.
 *
 * Why: layouts like `MobileProjectScreen` and `MobileSettingsLayout`
 * run a framer-motion `initial={{ x: '100%' }} animate={{ x: 0 }}`
 * slide on every mount. That's correct on a forward navigation
 * (home → project), but on a back navigation from session detail the
 * destination *also* re-mounts, so the user sees the chat slide off
 * to the right and then the destination slide *in* from the right —
 * i.e. an iOS push visual on a pop navigation.
 *
 * `MobileDrillPageLayout` calls `markMobileBackNavigation()`
 * right before triggering the actual route change. Each destination
 * page calls `consumeMobileBackNavigation()` once on mount, in a
 * `useState` initializer so the value is stable across re-renders.
 * The flag is consumed (cleared) on read so a subsequent forward
 * navigation to the same page still gets its enter slide.
 *
 * Module-level boolean instead of jotai/context because the lifetime
 * is intentionally one-shot and synchronous — a Provider would just
 * add render-tree plumbing for a flag that only matters during the
 * navigation tick itself.
 */
let suppressNextEnter = false;

export function markMobileBackNavigation(): void {
  suppressNextEnter = true;
}

export function consumeMobileBackNavigation(): boolean {
  if (suppressNextEnter) {
    suppressNextEnter = false;
    return true;
  }
  return false;
}
