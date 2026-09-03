/** Visibility mechanics shared by the retained Lody route trees. */
import {
  Activity,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { markLodyActivationPhase } from "./surface-activation-performance.js";

function LodyActivityRevealMarker({ targetKey }: { targetKey?: string }) {
  useLayoutEffect(() => {
    if (targetKey !== undefined) markLodyActivationPhase(targetKey, "activity-reveal-commit");
  }, [targetKey]);
  useEffect(() => {
    if (targetKey === undefined) return undefined;
    const timer = setTimeout(() => {
      markLodyActivationPhase(targetKey, "effects-settled");
    }, 0);
    return () => clearTimeout(timer);
  }, [targetKey]);
  return null;
}

export function LodyRouteActivity(props: {
  active: boolean;
  performanceTargetKey?: string;
  children: ReactNode;
}) {
  return (
    <Activity mode={props.active ? "visible" : "hidden"}>
      <LodyActivityRevealMarker targetKey={props.performanceTargetKey} />
      {props.children}
    </Activity>
  );
}

function composerIn(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('textarea, [contenteditable="true"]');
}

interface ScrollPosition {
  element: HTMLElement;
  top: number;
  left: number;
}

function scrollableDescendants(root: HTMLElement): HTMLElement[] {
  const selector = ".chat-scrollbar, [data-radix-scroll-area-viewport], [data-lody-preserve-scroll]";
  const descendants = [...root.querySelectorAll<HTMLElement>(selector)];
  return root.matches(selector) ? [root, ...descendants] : descendants;
}

/**
 * Makes an inactive surface inaccessible and restores its last useful focus on
 * reveal. The route tree's effects are handled separately by Activity.
 */
export function LodySurfaceVisibilityRoot(props: {
  hidden: boolean;
  active?: boolean;
  performanceTargetKey?: string;
  className: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const scrollPositionsRef = useRef<ScrollPosition[]>([]);
  const wasHiddenRef = useRef(false);

  useInsertionEffect(() => {
    if (props.hidden) return undefined;
    return () => {
      const root = rootRef.current;
      if (root === null) return;
      scrollPositionsRef.current = scrollableDescendants(root).map((element) => ({
        element,
        top: element.scrollTop,
        left: element.scrollLeft,
      }));
    };
  }, [props.hidden]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return undefined;
    if (props.hidden) {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && root.contains(focused)) {
        lastFocusedRef.current = focused;
      }
      wasHiddenRef.current = true;
      return undefined;
    }
    if (props.active !== false && props.performanceTargetKey !== undefined) {
      markLodyActivationPhase(props.performanceTargetKey, "surface-visible-commit");
    }
    if (!wasHiddenRef.current) return undefined;
    wasHiddenRef.current = false;
    for (const position of scrollPositionsRef.current) {
      if (!position.element.isConnected || !root.contains(position.element)) continue;
      position.element.scrollTop = position.top;
      position.element.scrollLeft = position.left;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || rootRef.current !== root) return;
      const previous = lastFocusedRef.current;
      const target =
        previous !== null && previous.isConnected && root.contains(previous)
          ? previous
          : composerIn(root) ?? root;
      target.focus({ preventScroll: true });
      if (props.performanceTargetKey !== undefined) {
        markLodyActivationPhase(props.performanceTargetKey, "focus-restore");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [props.active, props.hidden, props.performanceTargetKey]);

  return (
    <div
      ref={rootRef}
      className={props.className}
      data-lody-active={props.active === false ? "false" : "true"}
      data-lody-performance-target={props.performanceTargetKey}
      hidden={props.hidden}
      inert={props.hidden}
      aria-hidden={props.hidden ? "true" : undefined}
      tabIndex={-1}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement) lastFocusedRef.current = event.target;
      }}
    >
      {props.children}
    </div>
  );
}
