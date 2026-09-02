/** Visibility mechanics shared by the retained Lody route trees. */
import { Activity, useLayoutEffect, useRef, type ReactNode } from "react";

export function LodyRouteActivity(props: { active: boolean; children: ReactNode }) {
  return <Activity mode={props.active ? "visible" : "hidden"}>{props.children}</Activity>;
}

function composerIn(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('textarea, [contenteditable="true"]');
}

/**
 * Makes an inactive surface inaccessible and restores its last useful focus on
 * reveal. The route tree's effects are handled separately by Activity.
 */
export function LodySurfaceVisibilityRoot(props: {
  hidden: boolean;
  className: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const wasHiddenRef = useRef(false);

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
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || rootRef.current !== root) return;
      const previous = lastFocusedRef.current;
      const target =
        previous !== null && previous.isConnected && root.contains(previous)
          ? previous
          : composerIn(root) ?? root;
      target.focus({ preventScroll: true });
    });
    return () => {
      cancelled = true;
    };
  }, [props.hidden]);

  return (
    <div
      ref={rootRef}
      className={props.className}
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
