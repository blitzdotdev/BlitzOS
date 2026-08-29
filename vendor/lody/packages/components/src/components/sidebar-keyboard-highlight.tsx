import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import {
  focusLayerAtom,
  sidebarHighlightIndexAtom,
  sidebarNavItemsAtom,
} from '@/atoms/focus-layer';

const HIGHLIGHT_CLASS = 'keyboard-nav-highlight';

/**
 * Get a CSS selector for the highlighted sidebar item.
 */
function getItemSelector(item: import('@/atoms/focus-layer').SidebarNavItem): string | null {
  switch (item.kind) {
    case 'session':
      return `[data-sidebar-session-id="${item.sessionId}"], [data-sidebar-updated-id="${item.sessionId}"]`;
    case 'group-header':
      return `[data-sidebar-group-key="${item.groupKey}"]`;
    case 'local-project':
      return `[data-sidebar-project-key="${item.machineId}:${item.localProjectId}"]`;
    case 'show-more':
      return `[data-sidebar-show-more="${item.groupKey}"]`;
    default:
      return null;
  }
}

/**
 * Manages the visual highlight for keyboard navigation in the sidebar.
 * Adds/removes a CSS class on the element matching the current highlight index.
 * Also scrolls the highlighted element into view.
 *
 * Mount this component inside the sidebar.
 */
export function SidebarKeyboardHighlight() {
  const focusLayer = useAtomValue(focusLayerAtom);
  const highlightIndex = useAtomValue(sidebarHighlightIndexAtom);
  const navItems = useAtomValue(sidebarNavItemsAtom);

  useEffect(() => {
    // Remove any existing highlight
    const prev = document.querySelector(`.${HIGHLIGHT_CLASS}`);
    if (prev) {
      prev.classList.remove(HIGHLIGHT_CLASS);
    }

    // Only show highlight when in L1
    if (focusLayer !== 'L1' || highlightIndex < 0) return undefined;

    const item = navItems[highlightIndex];
    if (!item) return undefined;

    const selector = getItemSelector(item);
    if (!selector) return undefined;

    const el = document.querySelector(selector);
    if (!el) return undefined;

    el.classList.add(HIGHLIGHT_CLASS);
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    return () => {
      el.classList.remove(HIGHLIGHT_CLASS);
    };
  }, [focusLayer, highlightIndex, navItems]);

  return null;
}
