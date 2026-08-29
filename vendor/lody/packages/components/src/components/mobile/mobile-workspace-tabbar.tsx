import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { PencilLine } from 'lucide-react';
import { isIOSRuntimeEnvironment } from '@/lib/native-platform';
import { cn } from '@/lib/utils';

/* Floating bottom dock used by the mobile home AND the in-project
   detail page. A pill on the left holds the tab buttons (each with
   icon + label) with a FLIP-animated active highlight; an optional
   circular new-chat chip floats to the right. The two consumers
   pass their own tabs — home uses Chat / Local / GitHub, project
   uses Chat / Files / Settings.

   When the consumer passes a `scrollContainerRef`, the dock observes
   scroll on that element and collapses whenever the user scrolls in
   either direction past `COLLAPSE_THRESHOLD` cumulative pixels — the
   pill morphs into a circular icon of the current tab, and the new-
   chat chip shrinks to 90% (transform origin anchored to the bottom-
   right of the chip; the pill anchors to the bottom-left). The dock
   auto-expands again the moment the list scrolls back to the top.
   Tapping the collapsed circle expands the dock in place (without
   scrolling); the accumulator resets so the next micro-scroll
   doesn't immediately re-collapse it.

   Kept under the `mobile-workspace-tabbar` name + file path because
   that's where the styling tokens (mobile-workspace-dock /
   mobile-tabbar-glass / mobile-workspace-new-chat) live in
   tailwind/index.css. The component is generic — consumers provide
   the tab list. */

export type MobileBottomTabBarTabSpec<TabKey extends string = string> = {
  key: TabKey;
  ios: ReactNode;
  material: ReactNode;
  /** Already-translated label rendered under the icon. */
  label: string;
};

/* Re-exported under both names for back-compat. */
export type MobileWorkspaceTab = 'local' | 'github' | 'chat';

export type MobileWorkspaceTabBarLabels = {
  localTab?: string;
  githubTab?: string;
  chatTab?: string;
  newChatAriaLabel?: string;
};

export type MobileWorkspaceTabBarScrollSignal = {
  readonly scrollTop: number;
  readonly seq: number;
};

export type MobileWorkspaceTabBarProps<TabKey extends string = string> = {
  tabs: ReadonlyArray<MobileBottomTabBarTabSpec<TabKey>>;
  /** Active tab. `null` shows no highlight (e.g. on the settings
     page, which is reachable from this bar but isn't itself one of
     the tabs). */
  selectedTab: TabKey | null;
  onTabSelect: (tab: TabKey) => void;
  /** When provided, renders the separate new-chat chip to the right
     of the tabbar pill. Omit when the surface doesn't make sense as
     a new-conversation entry point. */
  onNewChat?: () => void;
  newChatAriaLabel?: string;
  ariaLabel?: string;
  /** Distinct layoutId per tabbar instance so each one has its own
     FLIP-animated highlight. Defaults to a shared id; pass an
     instance-specific one when two tabbars might mount in the same
     React subtree. */
  layoutId?: string;
  theme?: 'ios' | 'material';
  /** When provided, the dock observes scroll on this element and
     collapses while the user scrolls down. Omit to keep the dock
     always expanded. */
  scrollContainerRef?: RefObject<HTMLElement | null>;
  /** Imperative scroll signal for surfaces whose real scroll state is not a
     native DOM scroll event on a stable element, e.g. Monaco. */
  scrollSignal?: MobileWorkspaceTabBarScrollSignal | null;
  /** Aria label for the "tap to expand" affordance on the collapsed
     state's single visible chip. Defaults to a Chinese fallback. */
  expandAriaLabel?: string;
};

/* Cumulative scroll distance (px, either direction) the user has to
   traverse from a fresh expanded state before the dock collapses.
   Small so the collapse feels responsive without triggering on
   micro-scrolls. */
const COLLAPSE_THRESHOLD = 24;

/* When the scroll container reaches the top (within this slack in
   pixels — iOS rubber-banding can momentarily land at 1-2px), the
   dock auto-expands. The slack keeps the at-top expand from being
   defeated by fractional scroll positions. */
const AT_TOP_SLACK = 4;

/* Slightly underdamped spring so the morph reads as a single
   continuous motion rather than a snap. Tuned to be a touch slower
   than the previous setting (stiffness was 360) — the user's
   feedback was that the expand felt too quick to register. Shared by
   the tab pill, active-tab highlight, and new-chat FAB so all three
   settle in lockstep. */
const COLLAPSE_TRANSITION = {
  type: 'spring' as const,
  stiffness: 220,
  damping: 30,
  mass: 0.9,
};

/* Dock chip sizes — expanded tab pill + FAB share the same height so
   they sit on one baseline; collapsed both become equal circles. */
const COLLAPSED_CHIP_PX = 48;
const EXPANDED_CHIP_PX = 56;

export function MobileWorkspaceTabBar<TabKey extends string = string>({
  tabs,
  selectedTab,
  onTabSelect,
  onNewChat,
  newChatAriaLabel,
  ariaLabel,
  layoutId = 'mobile-workspace-tabbar',
  theme,
  scrollContainerRef,
  scrollSignal,
  expandAriaLabel,
}: MobileWorkspaceTabBarProps<TabKey>) {
  const resolvedTheme: 'ios' | 'material' =
    theme ?? (isIOSRuntimeEnvironment() ? 'ios' : 'material');
  const [collapsed, setCollapsed] = useState(false);

  /* Cumulative absolute scroll distance since the last expanded
     state. Held in a ref (not in the closure's `let`) so the manual
     expand path can reset it from outside the scroll listener — if
     we leave the accumulator at its over-threshold value after a
     tap-to-expand, the very next scroll event would re-cross the
     threshold and snap the dock back to collapsed instantly. */
  const cumulativeScrollRef = useRef(0);
  const lastScrollTopRef = useRef<number | null>(null);

  const applyScrollTop = useCallback((scrollTop: number) => {
    const nextScrollTop = Math.max(0, scrollTop);
    const previousScrollTop = lastScrollTopRef.current ?? nextScrollTop;
    const delta = nextScrollTop - previousScrollTop;
    lastScrollTopRef.current = nextScrollTop;
    if (nextScrollTop <= AT_TOP_SLACK) {
      cumulativeScrollRef.current = 0;
      setCollapsed(false);
      return;
    }
    cumulativeScrollRef.current += Math.abs(delta);
    if (cumulativeScrollRef.current >= COLLAPSE_THRESHOLD) {
      setCollapsed(true);
    }
  }, []);

  useEffect(() => {
    const element = scrollContainerRef?.current;
    if (!element) return undefined;
    /* Two rules, both monitored on every scroll event:
         - At-top  → expand. The user has come back to the start of the
                     list and probably wants the full dock again.
         - Any cumulative motion past `COLLAPSE_THRESHOLD` → collapse.
                     We accumulate the ABSOLUTE delta, not the signed
                     one, so scrolling up or down counts equally. The
                     accumulator resets at the at-top expand and at
                     manual expand via `expand()` so subsequent
                     engagement gets a fresh 24px window. */
    lastScrollTopRef.current = element.scrollTop;
    const handleScroll = () => {
      applyScrollTop(element.scrollTop);
    };
    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => element.removeEventListener('scroll', handleScroll);
  }, [applyScrollTop, scrollContainerRef]);

  useEffect(() => {
    if (!scrollSignal) return;
    applyScrollTop(scrollSignal.scrollTop);
  }, [applyScrollTop, scrollSignal]);

  /* Tap on the collapsed circle: expand in place. We do NOT scroll
     the list to the top — the user explicitly asked for in-place
     expand. Resetting the accumulator gives them a fresh 24px window
     to interact with the expanded tabs before the next collapse
     triggers, so the expansion isn't visually undone by their next
     micro-scroll. */
  const expand = () => {
    cumulativeScrollRef.current = 0;
    lastScrollTopRef.current = null;
    setCollapsed(false);
  };

  return (
    <div
      className={cn(
        'mobile-workspace-dock fixed left-0 right-0 bottom-0 z-30',
        'flex items-end justify-between gap-3 px-4 pt-2',
        'pb-[calc(0.5rem+var(--k-safe-area-bottom,0px))]'
      )}
    >
      <LayoutGroup id={layoutId}>
        <motion.div
          layout
          transition={COLLAPSE_TRANSITION}
          role="tablist"
          aria-label={ariaLabel ?? '导航'}
          className={cn(
            'mobile-workspace-tab-pill mobile-tabbar-glass relative flex items-center rounded-full text-foreground',
            collapsed
              ? 'h-12 w-12 shrink-0 justify-center overflow-hidden p-0'
              : 'h-14 min-w-0 flex-1 justify-around gap-1 px-2 py-1.5'
          )}
        >
          <AnimatePresence initial={false}>
            {tabs.map((tab) => {
              const isActive = tab.key === selectedTab;
              if (collapsed && !isActive) return null;
              return (
                <motion.button
                  key={tab.key}
                  layout
                  initial={false}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.18 }}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-label={
                    collapsed && isActive ? (expandAriaLabel ?? '展开导航') : undefined
                  }
                  className={cn(
                    /* `isolate` keeps the active highlight above the solid
                       dock card (negative z used to sink under it and look
                       like “font-only” selection). */
                    'mobile-workspace-tab relative isolate inline-flex flex-col items-center justify-center rounded-full text-[0.72rem] font-medium',
                    collapsed
                      ? 'h-full w-full p-0 text-foreground'
                      : cn(
                          'h-full flex-1 gap-0.5 px-2 py-1 transition-colors',
                          isActive
                            ? 'text-primary'
                            : 'text-muted-foreground active:text-foreground'
                        )
                  )}
                  onClick={() => {
                    if (collapsed) {
                      expand();
                    } else {
                      onTabSelect(tab.key);
                    }
                  }}
                >
                  {isActive && !collapsed ? (
                    <motion.span
                      layoutId={`${layoutId}-highlight`}
                      transition={COLLAPSE_TRANSITION}
                      aria-hidden="true"
                      className="absolute inset-0 z-0 rounded-full bg-primary/20 dark:bg-primary/25"
                    />
                  ) : null}
                  {/* Force a 24px icon slot so consumer SVGs can't collapse to
                      the label's em size (text-[0.72rem] on this button). */}
                  <span className="relative z-10 inline-flex size-6 shrink-0 items-center justify-center [&>svg]:h-6 [&>svg]:w-6">
                    {resolvedTheme === 'ios' ? tab.ios : tab.material}
                  </span>
                  {!collapsed ? (
                    <span className="relative z-10 leading-none">{tab.label}</span>
                  ) : null}
                </motion.button>
              );
            })}
          </AnimatePresence>
        </motion.div>
      </LayoutGroup>
      {onNewChat ? (
        <motion.button
          /* Explicit width/height spring (not CSS scale) so collapse
             matches the left pill's size morph. `transition-transform`
             was removed — it fought framer-motion and made the FAB
             jump instead of easing. */
          animate={{
            width: collapsed ? COLLAPSED_CHIP_PX : EXPANDED_CHIP_PX,
            height: collapsed ? COLLAPSED_CHIP_PX : EXPANDED_CHIP_PX,
          }}
          transition={COLLAPSE_TRANSITION}
          type="button"
          aria-label={newChatAriaLabel ?? '新建对话'}
          onClick={onNewChat}
          className={cn(
            /* High-contrast FAB: light = black fill + white icon,
               dark = white fill + black icon — via inverted
               foreground/background tokens (not the frosted glass
               used by the tab pill). */
            'mobile-workspace-new-chat inline-flex shrink-0 items-center justify-center rounded-full',
            'bg-foreground text-background',
            'shadow-[0_6px_20px_-6px_rgba(0,0,0,0.28),0_2px_8px_-2px_rgba(0,0,0,0.16)]',
            'dark:shadow-[0_8px_24px_-6px_rgba(0,0,0,0.55)]',
            'active:opacity-90'
          )}
        >
          <PencilLine className="h-6 w-6" strokeWidth={1.85} aria-hidden="true" />
        </motion.button>
      ) : null}
    </div>
  );
}
