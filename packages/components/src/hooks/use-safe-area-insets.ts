import * as React from 'react';

/**
 * Read the device safe-area insets as numbers so they can be fed into Radix's
 * `collisionPadding` (which only accepts numbers). Without this, floating
 * surfaces (dropdowns, popovers) may open beneath the iPhone Dynamic Island /
 * status bar and become unreachable when their option list is taller than the
 * viewport.
 */
export function useSafeAreaInsets() {
  const [insets, setInsets] = React.useState({ top: 0, right: 0, bottom: 0, left: 0 });
  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      const px = (name: string) => {
        const n = parseFloat(cs.getPropertyValue(name));
        return Number.isFinite(n) ? n : 0;
      };
      setInsets({
        top: px('--safe-area-top'),
        right: px('--safe-area-right'),
        bottom: px('--safe-area-bottom'),
        left: px('--safe-area-left'),
      });
    };
    read();
    window.addEventListener('resize', read);
    window.addEventListener('orientationchange', read);
    return () => {
      window.removeEventListener('resize', read);
      window.removeEventListener('orientationchange', read);
    };
  }, []);
  return insets;
}
