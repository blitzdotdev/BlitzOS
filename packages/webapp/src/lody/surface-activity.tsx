/** Visibility mechanics shared by the retained Lody route trees. */
import {
  Activity,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

export function LodyRouteActivity(props: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Activity mode={props.active ? "visible" : "hidden"}>
      {props.children}
    </Activity>
  );
}

function composerIn(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('textarea, [contenteditable="true"]');
}

interface ScrollPosition {
  selector: string;
  index: number;
  top: number;
  left: number;
}

const PRESERVED_SCROLL_SELECTORS = [
  ".chat-scrollbar",
  "[data-radix-scroll-area-viewport]",
  "[data-lody-preserve-scroll]",
] as const;

function elementsMatching(root: HTMLElement, selector: string): HTMLElement[] {
  const descendants = [...root.querySelectorAll<HTMLElement>(selector)];
  return root.matches(selector) ? [root, ...descendants] : descendants;
}

function captureScrollPositions(root: HTMLElement): ScrollPosition[] {
  const captured = new Set<HTMLElement>();
  const positions: ScrollPosition[] = [];
  for (const selector of PRESERVED_SCROLL_SELECTORS) {
    elementsMatching(root, selector).forEach((element, index) => {
      if (captured.has(element)) return;
      captured.add(element);
      positions.push({ selector, index, top: element.scrollTop, left: element.scrollLeft });
    });
  }
  return positions;
}

/**
 * Makes an inactive surface inaccessible and restores its last useful focus on
 * reveal. The route tree's effects are handled separately by Activity.
 */
export function LodySurfaceVisibilityRoot(props: {
  hidden: boolean;
  active?: boolean;
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
      scrollPositionsRef.current = captureScrollPositions(root);
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
    if (!wasHiddenRef.current) return undefined;
    wasHiddenRef.current = false;
    for (const position of scrollPositionsRef.current) {
      const element = elementsMatching(root, position.selector)[position.index];
      if (element === undefined) continue;
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
    }
    const previous = lastFocusedRef.current;
    const target =
      previous !== null && previous.isConnected && root.contains(previous)
        ? previous
        : composerIn(root) ?? root;
    target.focus({ preventScroll: true });
    return undefined;
  }, [props.active, props.hidden]);

  return (
    <div
      ref={rootRef}
      className={props.className}
      data-lody-active={props.active === false ? "false" : "true"}
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
