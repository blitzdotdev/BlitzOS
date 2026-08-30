import * as React from 'react';
import { MOBILE_LAYOUT_BREAKPOINT } from '@lody/shared/layout';
import { detectAppDeviceClass } from '@/lib/device-class';

/**
 * Mobile layout follows a narrow viewport or a phone identity. The identity
 * fallback keeps phones in the mobile renderer when landscape width crosses the
 * breakpoint, while desktop browser resizing and wide tablets retain their
 * existing behavior.
 * Native-only behavior should still use `isNativeAppShell()` separately.
 *
 * Context value:
 * - `true`  — force mobile layout (landing phone frame)
 * - `false` — force desktop layout (landing worktree/diff/design demos on phones)
 * - `null`  — follow the viewport breakpoint
 */
const ForceMobileLayoutContext = React.createContext<boolean | null>(null);

export function ForceMobileLayoutProvider({
  force,
  children,
}: {
  force: boolean;
  children: React.ReactNode;
}) {
  // Only force mobile when `force` is true. `force={false}` leaves the viewport
  // in charge (same as no provider) so callers can wrap optionally.
  return React.createElement(
    ForceMobileLayoutContext.Provider,
    { value: force ? true : null },
    children
  );
}

/** Force the desktop (wide) layout regardless of viewport width. */
export function ForceDesktopLayoutProvider({ children }: { children: React.ReactNode }) {
  return React.createElement(ForceMobileLayoutContext.Provider, { value: false }, children);
}

export function checkIsMobileDevice(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.innerWidth < MOBILE_LAYOUT_BREAKPOINT || detectAppDeviceClass() === 'mobile';
}

export function useIsMobile() {
  const forced = React.useContext(ForceMobileLayoutContext);
  const [isMobile, setIsMobile] = React.useState<boolean>(() => {
    return checkIsMobileDevice();
  });

  React.useEffect(() => {
    const update = () => {
      setIsMobile(checkIsMobileDevice());
    };

    // matchMedia fires when crossing the breakpoint threshold (efficient for desktop resizing)
    const mql = window.matchMedia(`(max-width: ${MOBILE_LAYOUT_BREAKPOINT - 1}px)`);
    mql.addEventListener('change', update);

    // resize fires after viewport dimensions are fully updated, which is needed
    // because on mobile orientation changes matchMedia can fire before
    // window.innerWidth reflects the new dimensions
    window.addEventListener('resize', update);

    update();
    return () => {
      mql.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  if (forced !== null) return forced;
  return isMobile;
}
