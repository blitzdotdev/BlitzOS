import { type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useLocation } from '@tanstack/react-router';
import { LoroAppSidebar } from './loro-app-sidebar';
import { ErrorBoundary } from './error-boundary';
import { useKeyboardNavigation } from '../hooks/use-keyboard-navigation';
import { focusLayerAtom, sidebarCollapsedAtom, sidebarLastWidthAtom } from '../atoms';
import { cn } from '@/lib/utils';
import { isWindowsElectronRenderer, useElectronFullscreen } from '@/lib/electron';
import { isSettingsRoute, NATIVE_KEYBOARD_OFFSET_CLASS } from './workspace-layout-utils';

// LoroSidebar's default expanded width (see loro-sidebar.tsx `defaultWidth`);
// `sidebarLastWidthAtom` stores 0 until the user resizes, so fall back to this.
const DEFAULT_SIDEBAR_WIDTH = 280;
// Extra px the sidebar card is inset by (`ml-2` + `mr-1` in loro-app-sidebar),
// added to the slide distance so it clears fully off the left edge.
const SIDEBAR_GUTTER = 12;

export function WebWorkspaceLayout({ children }: { children: ReactNode }) {
  // Only the pathname drives this layout (settings branch + error boundary
  // resets), so search-only navigations (dialogs, panels) don't re-render the
  // whole workspace shell.
  const pathname = useLocation({ select: (l) => l.pathname });
  const focusLayer = useAtomValue(focusLayerAtom);
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const sidebarLastWidth = useAtomValue(sidebarLastWidthAtom);
  const shouldReduceMotion = useReducedMotion();
  const isElectronFullscreen = useElectronFullscreen();

  useKeyboardNavigation();

  // On Windows the native title bar is hidden and the caption buttons are an
  // OS overlay at the top-right; reserve the drag band behind them (36px,
  // matching MAIN_WINDOW_TITLE_BAR_OVERLAY_HEIGHT in
  // apps/electron/src/main/window-theme.ts and the drag strip in
  // routes/__root.tsx) so page content never sits under the buttons.
  const windowsTitleBarPadding =
    isWindowsElectronRenderer() && !isElectronFullscreen ? 'pt-9' : undefined;

  if (isSettingsRoute(pathname)) {
    return (
      <div
        className={cn(
          'flex h-svh w-full overflow-hidden bg-background',
          NATIVE_KEYBOARD_OFFSET_CLASS,
          windowsTitleBarPadding
        )}
      >
        <div className="min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary name="AppContent" variant="section" resetKeys={[pathname]}>
            {children}
          </ErrorBoundary>
        </div>
      </div>
    );
  }

  // Slide the sidebar in/out horizontally on collapse/expand. Animating
  // `marginLeft` (not width/transform) both slides the card off the left edge —
  // clipped by this row's `overflow-hidden` — and reclaims the flex space so the
  // content pane grows to fill. AnimatePresence keeps the sidebar mounted for the
  // exit slide, then unmounts it. marginLeft stays 0 while expanded, so live
  // resize never fights the animation.
  const sidebarSlideWidth =
    (sidebarLastWidth > 0 ? sidebarLastWidth : DEFAULT_SIDEBAR_WIDTH) + SIDEBAR_GUTTER;

  return (
    <div
      className={cn(
        'flex h-svh w-full overflow-hidden bg-background',
        NATIVE_KEYBOARD_OFFSET_CLASS,
        windowsTitleBarPadding
      )}
    >
      <AnimatePresence initial={false}>
        {!sidebarCollapsed && (
          <motion.div
            key="app-sidebar"
            className="h-full shrink-0"
            initial={{ marginLeft: -sidebarSlideWidth }}
            animate={{ marginLeft: 0 }}
            exit={{ marginLeft: -sidebarSlideWidth }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.22, ease: [0.32, 0.72, 0, 1] }}
          >
            <ErrorBoundary name="AppSidebar" variant="section" resetKeys={[pathname]}>
              <LoroAppSidebar
                className={cn(
                  'h-full transition-shadow duration-150',
                  focusLayer === 'L1' && 'ring-2 ring-ring/30 ring-inset rounded-2xl'
                )}
              />
            </ErrorBoundary>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex min-w-0 flex-1 overflow-hidden">
        <ErrorBoundary name="AppContent" variant="section" resetKeys={[pathname]}>
          <div className="flex h-full min-w-0 w-full flex-1 flex-col overflow-hidden">
            {children}
          </div>
        </ErrorBoundary>
      </div>
    </div>
  );
}
