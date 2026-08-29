import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  ONLY_CHATS_KEY,
  focusLayerAtom,
  sidebarHighlightIndexAtom,
  sidebarNavItemsAtom,
  sidebarNavCallbacksAtom,
  type FocusLayer,
  type SidebarNavCallbacks,
  type SidebarNavItem,
} from '@/atoms/focus-layer';
import { toggleSidebarCollapsedAtom } from '@/atoms/sidebar-state';
import { getCommandKeybindings, useCommand } from '@/lib/commands';
import { isImeComposingNativeKeyboardEvent } from '@/lib/ime';
import { useIsMobile } from './use-mobile';

// Re-export types from atoms for convenience
export type { SidebarNavItem, FocusLayer };

const SCROLL_STEP = 120;

/**
 * Check if the active element is a text input (textarea, input, contenteditable).
 */
function isTextInputActive(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const inputType = el.type.toLowerCase();
    return ['text', 'search', 'url', 'email', 'password', 'tel', 'number'].includes(inputType);
  }
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return false;
}

/**
 * Check if a dropdown/popup/dialog is open by looking for common patterns.
 */
function isPopupOpen(): boolean {
  return (
    document.querySelector('[data-radix-popper-content-wrapper]') !== null ||
    document.querySelector('[role="dialog"][data-state="open"]') !== null ||
    document.querySelector('[data-radix-menu-content]') !== null
  );
}

function focusComposer() {
  const textarea = document.querySelector<HTMLTextAreaElement>('[data-keyboard-nav="composer"]');
  textarea?.focus();
}

function blurComposer() {
  const textarea = document.querySelector<HTMLTextAreaElement>('[data-keyboard-nav="composer"]');
  textarea?.blur();
}

function scrollChatContent(direction: 'up' | 'down') {
  const container = document.querySelector('.chat-scrollbar');
  if (container) {
    container.scrollBy({
      top: direction === 'up' ? -SCROLL_STEP : SCROLL_STEP,
      behavior: 'smooth',
    });
  }
}

function toggleGroupCollapsed(cb: SidebarNavCallbacks, groupKey: string) {
  if (groupKey === ONLY_CHATS_KEY) {
    cb.onToggleChatsCollapsed();
  } else {
    cb.onToggleRepoCollapsed(groupKey);
  }
}

/**
 * Main keyboard navigation hook. Must be mounted once at the app root.
 * Reads sidebar items and callbacks from Jotai atoms.
 */
export function useKeyboardNavigation() {
  const { t } = useTranslation();
  const [focusLayer, setFocusLayer] = useAtom(focusLayerAtom);
  const [highlightIndex, setHighlightIndex] = useAtom(sidebarHighlightIndexAtom);
  const flatItems = useAtomValue(sidebarNavItemsAtom);
  const sidebarCallbacks = useAtomValue(sidebarNavCallbacksAtom);
  const toggleSidebarCollapsed = useSetAtom(toggleSidebarCollapsedAtom);
  const isMobile = useIsMobile();

  const flatItemsRef = useRef(flatItems);
  flatItemsRef.current = flatItems;
  const callbacksRef = useRef(sidebarCallbacks);
  callbacksRef.current = sidebarCallbacks;

  const getVisibleSessionIds = useCallback(
    () =>
      flatItemsRef.current
        .filter((it): it is SidebarNavItem & { kind: 'session' } => it.kind === 'session')
        .map((it) => it.sessionId),
    []
  );

  const transitionTo = useCallback(
    (layer: FocusLayer) => {
      setFocusLayer(layer);
      if (layer === 'L1') {
        const cb = callbacksRef.current;
        const selectedId = cb?.getSelectedSessionId();
        if (selectedId) {
          const items = flatItemsRef.current;
          const idx = items.findIndex(
            (item) => item.kind === 'session' && item.sessionId === selectedId
          );
          if (idx >= 0) {
            setHighlightIndex(idx);
            return;
          }
          // Session is hidden (collapsed group or beyond show-more limit).
          // Find its parent group header so the highlight lands on something meaningful.
          const groupKey = cb?.getSessionGroupKey?.(selectedId);
          if (groupKey) {
            const headerIdx = items.findIndex(
              (item) =>
                (item.kind === 'group-header' && item.groupKey === groupKey) ||
                (item.kind === 'local-project' &&
                  `${item.machineId}:${item.localProjectId}` === groupKey)
            );
            if (headerIdx >= 0) {
              setHighlightIndex(headerIdx);
              return;
            }
          }
        }
        setHighlightIndex((prev) => (prev < 0 && flatItemsRef.current.length > 0 ? 0 : prev));
      } else if (layer === 'L3') {
        focusComposer();
      } else if (layer === 'L2') {
        blurComposer();
      }
    },
    [setFocusLayer, setHighlightIndex]
  );

  const navigateVisibleSession = useCallback(
    (direction: 'previous' | 'next') => {
      const cb = callbacksRef.current;
      if (!cb) return;

      const sessionIds = getVisibleSessionIds();
      const currentId = cb.getSelectedSessionId();
      if (sessionIds.length === 0) return;

      const currentIdx = currentId ? sessionIds.indexOf(currentId) : -1;
      const nextIdx =
        direction === 'previous'
          ? currentIdx > 0
            ? currentIdx - 1
            : 0
          : currentIdx < sessionIds.length - 1
            ? currentIdx + 1
            : sessionIds.length - 1;
      const nextId = sessionIds[nextIdx];
      if (nextId && nextId !== currentId) {
        cb.onNavigateToSession(nextId);
      }
    },
    [getVisibleSessionIds]
  );

  useCommand({
    id: 'sidebar.toggle',
    title: t('commands.sidebar.toggle', 'Toggle Sidebar'),
    category: 'View',
    keybindings: getCommandKeybindings('sidebar.toggle'),
    when: () => !isMobile,
    run: () => toggleSidebarCollapsed(),
  });

  useCommand({
    id: 'session.previousVisible',
    title: t('commands.session.previousVisible', 'Switch to Previous Session'),
    category: 'Navigation',
    keybindings: getCommandKeybindings('session.previousVisible'),
    when: () =>
      !isMobile &&
      !isPopupOpen() &&
      callbacksRef.current !== null &&
      getVisibleSessionIds().length > 0,
    run: () => navigateVisibleSession('previous'),
  });

  useCommand({
    id: 'session.nextVisible',
    title: t('commands.session.nextVisible', 'Switch to Next Session'),
    category: 'Navigation',
    keybindings: getCommandKeybindings('session.nextVisible'),
    when: () =>
      !isMobile &&
      !isPopupOpen() &&
      callbacksRef.current !== null &&
      getVisibleSessionIds().length > 0,
    run: () => navigateVisibleSession('next'),
  });

  const handleL1KeyDown = useCallback(
    (e: KeyboardEvent) => {
      const items = flatItemsRef.current;
      const cb = callbacksRef.current;
      if (!cb) return;

      switch (e.key) {
        case 'ArrowUp':
        case 'k': {
          e.preventDefault();
          setHighlightIndex((prev) => Math.max(0, prev - 1));
          break;
        }
        case 'ArrowDown':
        case 'j': {
          e.preventDefault();
          setHighlightIndex((prev) => Math.min(items.length - 1, prev + 1));
          break;
        }
        case 'ArrowRight': {
          e.preventDefault();
          const item = items[highlightIndex];
          if (!item) break;
          if (item.kind === 'group-header' && item.collapsed) {
            toggleGroupCollapsed(cb, item.groupKey);
          } else if (item.kind === 'local-project' && item.collapsed) {
            cb.onToggleLocalProjectCollapsed?.(item.machineId, item.localProjectId);
          }
          break;
        }
        case 'ArrowLeft': {
          e.preventDefault();
          const item = items[highlightIndex];
          if (!item) break;
          if (item.kind === 'group-header' && !item.collapsed) {
            toggleGroupCollapsed(cb, item.groupKey);
          } else if (item.kind === 'local-project' && !item.collapsed) {
            cb.onToggleLocalProjectCollapsed?.(item.machineId, item.localProjectId);
          } else if (item.kind === 'session') {
            const parentIdx = items.findIndex(
              (it) =>
                (it.kind === 'group-header' && it.groupKey === item.groupKey) ||
                (it.kind === 'local-project' &&
                  `${it.machineId}:${it.localProjectId}` === item.groupKey)
            );
            if (parentIdx >= 0) {
              setHighlightIndex(parentIdx);
            }
          }
          break;
        }
        case 'Enter': {
          e.preventDefault();
          const item = items[highlightIndex];
          if (!item) break;
          if (item.kind === 'session') {
            cb.onNavigateToSession(item.sessionId);
            transitionTo('L2');
          } else if (item.kind === 'group-header') {
            toggleGroupCollapsed(cb, item.groupKey);
          } else if (item.kind === 'show-more') {
            // Show-more state lives inside SessionList; click the DOM button directly.
            const btn = document.querySelector<HTMLElement>(
              `[data-sidebar-show-more="${item.groupKey}"]`
            );
            btn?.click();
          } else if (item.kind === 'local-project') {
            cb.onToggleLocalProjectCollapsed?.(item.machineId, item.localProjectId);
          }
          break;
        }
        case 'Escape':
          break;
        default:
          break;
      }
    },
    [highlightIndex, setHighlightIndex, transitionTo]
  );

  const handleL2KeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp':
        case 'k': {
          e.preventDefault();
          scrollChatContent('up');
          break;
        }
        case 'ArrowDown':
        case 'j': {
          e.preventDefault();
          scrollChatContent('down');
          break;
        }
        case 'Enter': {
          e.preventDefault();
          transitionTo('L3');
          break;
        }
        case 'Escape': {
          e.preventDefault();
          transitionTo('L1');
          break;
        }
        default:
          break;
      }
    },
    [transitionTo]
  );

  const handleL3KeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Esc just blurs the composer. It must NOT step focus down into the tab bar
      // (L2 ring) or the sidebar session list (L1 highlight) — those layers should
      // never auto-engage from the composer. (L1/L2 are only reachable via this
      // path, so this effectively keeps that roving focus from appearing on its own.)
      blurComposer();
    }
  }, []);

  const handleSingleLetterShortcuts = useCallback(
    (e: KeyboardEvent): boolean => {
      const cb = callbacksRef.current;
      if (!cb) return false;

      switch (e.key) {
        case 'c': {
          e.preventDefault();
          cb.onNavigateToNewSession();
          setFocusLayer('L3');
          return true;
        }
        default:
          return false;
      }
    },
    [setFocusLayer]
  );

  useEffect(() => {
    if (isMobile) return undefined;

    const handler = (e: KeyboardEvent) => {
      // Esc cancels an active IME preedit. It must not also leave the composer
      // focus layer after the browser/IME has handled that same keydown.
      if (isImeComposingNativeKeyboardEvent(e)) return;
      if (isPopupOpen()) return;

      if (e.metaKey || e.ctrlKey) return;

      if (isTextInputActive()) {
        if (focusLayer !== 'L3') {
          setFocusLayer('L3');
        }
        handleL3KeyDown(e);
        return;
      }

      if (focusLayer === 'L1' || focusLayer === 'L2') {
        if (e.key.length === 1 && !e.altKey && !e.shiftKey) {
          const handled = handleSingleLetterShortcuts(e);
          if (handled) return;
        }
      }

      if (focusLayer === 'L1') {
        handleL1KeyDown(e);
      } else if (focusLayer === 'L2') {
        handleL2KeyDown(e);
      } else {
        handleL3KeyDown(e);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    focusLayer,
    handleL1KeyDown,
    handleL2KeyDown,
    handleL3KeyDown,
    handleSingleLetterShortcuts,
    isMobile,
    setFocusLayer,
  ]);

  // Sync focus layer when user clicks into a text input
  useEffect(() => {
    if (isMobile) return undefined;

    const handler = () => {
      if (isTextInputActive() && focusLayer !== 'L3') {
        setFocusLayer('L3');
      }
    };

    document.addEventListener('focusin', handler);
    return () => document.removeEventListener('focusin', handler);
  }, [focusLayer, isMobile, setFocusLayer]);

  return { focusLayer, highlightIndex };
}
