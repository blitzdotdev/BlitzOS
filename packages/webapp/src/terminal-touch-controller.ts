import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Terminal } from '@xterm/xterm';
import { observeVisualViewportGeometry } from './mobile-webapp';
import { pasteToSession } from './session-input';
import { previewPortFromLocalUrl } from './preview';
import { parseTerminalChoiceRow } from './terminal-choices';
import { classifyTerminalInputRow } from './terminal-input';
import { isPasteKeyEvent } from './terminal-paste';
import {
  TERMINAL_KEYBOARD_EVENT,
  TERMINAL_PASTE_EVENT,
  TERMINAL_TOUCH_LONG_PRESS_MS,
  accumulateTerminalTouchWheelLines,
  isTerminalPromptTouch,
  terminalSelectionRange,
  terminalWordBoundary,
  type TerminalCell,
  type TerminalSelectionAnchor,
} from './terminal-touch';
import { keyboardGeometryUpdate } from './terminal-touch-keyboard';
import {
  terminalCellAtPoint as cellAtPoint,
  terminalSelectionChipPosition,
  terminalSelectionContainsCell,
} from './terminal-touch-selection';
import {
  clipboardReadDecision,
  suppressCompatibilityMouse,
  touchGestureMoved,
} from './terminal-touch-gestures';

export type SelectionChip = {
  visible: boolean;
  x: number;
  y: number;
};

type TouchSelection = {
  anchor: TerminalSelectionAnchor;
  extent: TerminalCell;
};

export type TerminalTouchOptions = {
  terminal: Terminal | null;
  surface: HTMLElement | null;
  viewportEl?: () => HTMLElement | null;
  sendInput: (data: string) => void;
  active: boolean;
  choiceMenuActiveRef: { readonly current: boolean };
  onOpenPreview?: (port: number) => boolean;
};

type TerminalTouchControllerOptions = TerminalTouchOptions & {
  pasteHintShown: { current: boolean };
  copyTouchSelection: { current: (() => Promise<void>) | null };
  clearTouchSelection: { current: (() => void) | null };
  setShowPasteHint: (visible: boolean) => void;
  setSelectionChip: (chip: SelectionChip) => void;
};

export function openTerminalWebLink(
  uri: string,
  onOpenPreview?: (port: number) => boolean,
  open: typeof window.open = window.open,
): boolean {
  try {
    const protocol = new URL(uri).protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return false;
  } catch {
    return false;
  }
  const previewPort = previewPortFromLocalUrl(uri);
  if (previewPort !== null && onOpenPreview?.(previewPort)) return true;
  open(uri, '_blank', 'noopener');
  return true;
}

export function bindTerminalTouch({
  terminal,
  surface,
  viewportEl,
  sendInput,
  active,
  choiceMenuActiveRef,
  onOpenPreview,
  pasteHintShown,
  copyTouchSelection,
  clearTouchSelection,
  setShowPasteHint,
  setSelectionChip,
}: TerminalTouchControllerOptions): (() => void) | undefined {
  if (!active || !terminal || !surface) return;

  const textarea = surface.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
  const xtermElement = surface.querySelector<HTMLElement>('.xterm');
  const screen = surface.querySelector<HTMLElement>('.xterm-screen');
  const nativeViewport = viewportEl?.()
    ?? surface.querySelector<HTMLElement>('.xterm-viewport');
  let hoveredWebLink: string | null = null;
  let suppressedCompatibilityLink: { uri: string; until: number } | null = null;
  const webLinksAddon = new WebLinksAddon(
    (_event, uri) => {
      if (
        suppressedCompatibilityLink?.uri === uri
        && Date.now() <= suppressedCompatibilityLink.until
      ) {
        suppressedCompatibilityLink = null;
        return;
      }
      suppressedCompatibilityLink = null;
      openTerminalWebLink(uri, onOpenPreview);
    },
    {
      hover: (_event, uri) => {
        hoveredWebLink = uri;
      },
      leave: (_event, uri) => {
        if (hoveredWebLink === uri) hoveredWebLink = null;
      },
    },
  );
  terminal.loadAddon(webLinksAddon);
  const setTextareaInputMode = (inputMode: 'none' | 'text') => {
    if (!textarea || textarea.getAttribute('inputmode') === inputMode) return;
    textarea.setAttribute('inputmode', inputMode);
  };
  let textareaFocused = Boolean(textarea) && document.activeElement === textarea;
  let keyboardHideRequested = false;
  const handleTextareaFocus = () => {
    textareaFocused = true;
    keyboardHideRequested = false;
  };
  const handleTextareaBlur = () => {
    textareaFocused = false;
    setTextareaInputMode('none');
  };
  let keyboardBaselineHeight = 0;
  let keyboardUp = false;
  const stopObservingKeyboardGeometry = observeVisualViewportGeometry((geometry) => {
    const update = keyboardGeometryUpdate({
      baselineHeight: keyboardBaselineHeight,
      keyboardUp,
      keyboardHideRequested,
      textareaFocused,
      geometry,
    });
    keyboardBaselineHeight = update.baselineHeight;
    keyboardUp = update.keyboardUp;
    keyboardHideRequested = update.keyboardHideRequested;
    if (update.resetInputMode) setTextareaInputMode('none');
  });
  const nativeScrollSpacer = document.createElement('div');
  nativeScrollSpacer.className = 'terminal-native-scroll-spacer';
  nativeScrollSpacer.setAttribute('aria-hidden', 'true');
  if (nativeViewport) {
    // Keep xterm's renderer in its original sibling topology. On coarse
    // pointers the native viewport is an invisible hit-test overlay; its
    // spacer supplies scroll range while the renderer remains stationary.
    // This avoids WebKit's sticky descendant inside an async scroller path.
    nativeViewport.append(nativeScrollSpacer);
    nativeViewport.dataset.nativeTouchScroll = 'true';
    nativeViewport.dataset.terminalBuffer = terminal.buffer.active.type;
  }
  setTextareaInputMode(textareaFocused ? 'text' : 'none');

  let disposed = false;
  let pasteHintTimeout: number | undefined;
  const showPasteFailureHint = () => {
    if (pasteHintShown.current) return;
    pasteHintShown.current = true;
    setShowPasteHint(true);
    pasteHintTimeout = window.setTimeout(() => setShowPasteHint(false), 5_000);
  };
  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (clipboardReadDecision(disposed, text, false) === 'paste') {
        pasteToSession(text, {
          bracketedPasteMode: terminal.modes.bracketedPasteMode,
          input: (payload) => {
            sendInput(payload);
            return true;
          },
        });
      }
    } catch {
      if (clipboardReadDecision(disposed, '', true) === 'hint') showPasteFailureHint();
    }
  };
  // Keyboard paste needs BOTH halves below — each alone is a shipped bug:
  // 1. Suppress the paste combos from xterm's keydown processing (send
  //    nothing!). Without this, xterm turns ctrl+V into the control byte
  //    \x16 and cancels the event, so the browser never fires a paste event
  //    and paste goes fully dead on non-mac.
  // 2. Own the native "paste" event in the capture phase: stopPropagation
  //    keeps xterm's own textarea paste listener from delivering the same
  //    clipboard a second time (sending from the keydown instead is what
  //    caused the double-paste — the un-prevented default still fired).
  const isMac = navigator.platform.toLowerCase().includes('mac');
  terminal.attachCustomKeyEventHandler((event) => !isPasteKeyEvent(event, isMac));
  const handleNativePaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain');
    event.preventDefault();
    event.stopPropagation();
    if (text) {
      pasteToSession(text, {
        bracketedPasteMode: terminal.modes.bracketedPasteMode,
        input: (payload) => {
          sendInput(payload);
          return true;
        },
      });
    }
  };
  surface.addEventListener('paste', handleNativePaste, { capture: true });

  let syncingNativeViewport = false;
  let programmaticScrollTop: number | null = null;
  let nativeScrollInputUntil = 0;
  const nativeRowHeight = () => {
    const currentScreen = surface.querySelector<HTMLElement>('.xterm-screen');
    return currentScreen && terminal.rows > 0
      ? currentScreen.getBoundingClientRect().height / terminal.rows
      : 0;
  };
  const refreshNativeScrollRange = () => {
    if (!nativeViewport?.isConnected || !nativeScrollSpacer.isConnected) return;
    const rowHeight = nativeRowHeight();
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;
    const scrollbackRows = terminal.buffer.active.baseY;
    nativeScrollSpacer.style.height = `${scrollbackRows * rowHeight + nativeViewport.clientHeight}px`;
  };
  const syncNativeScrollPosition = (line: number) => {
    if (!nativeViewport?.isConnected || syncingNativeViewport) return;
    const rowHeight = nativeRowHeight();
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;
    const nextScrollTop = line * rowHeight;
    if (Math.abs(nativeViewport.scrollTop - nextScrollTop) < 0.5) return;
    programmaticScrollTop = nextScrollTop;
    nativeViewport.scrollTop = nextScrollTop;
  };
  const handleNativeViewportScroll = () => {
    if (!nativeViewport) return;
    if (performance.now() > nativeScrollInputUntil) {
      programmaticScrollTop = null;
      return;
    }
    nativeScrollInputUntil = performance.now() + 1_000;
    if (
      programmaticScrollTop !== null
      && Math.abs(nativeViewport.scrollTop - programmaticScrollTop) < 0.5
    ) {
      programmaticScrollTop = null;
      return;
    }
    programmaticScrollTop = null;
    const rowHeight = nativeRowHeight();
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;
    const line = Math.max(0, Math.min(
      terminal.buffer.active.baseY,
      Math.round(nativeViewport.scrollTop / rowHeight),
    ));
    if (line === terminal.buffer.active.viewportY) return;
    syncingNativeViewport = true;
    terminal.scrollToLine(line);
    syncingNativeViewport = false;
  };
  nativeViewport?.addEventListener('scroll', handleNativeViewportScroll, { passive: true });
  const nativeTouchOverlayMedia = window.matchMedia('(hover: none) and (pointer: coarse)');
  const forwardViewportMouseEvent = (event: MouseEvent) => {
    if (!nativeTouchOverlayMedia.matches) return;
    // The coarse-pointer viewport must stay above the renderer to own native
    // touch scrolling, but xterm's linkifier listens directly on its screen
    // sibling. Mirror mouse input to that sibling without bubbling it back
    // through xterm's outer selection and focus handlers a second time.
    screen?.dispatchEvent(new MouseEvent(event.type, {
      bubbles: false,
      cancelable: event.cancelable,
      composed: event.composed,
      view: window,
      detail: event.detail,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      button: event.button,
      buttons: event.buttons,
      relatedTarget: event.relatedTarget,
    }));
  };
  nativeViewport?.addEventListener('mousemove', forwardViewportMouseEvent);
  nativeViewport?.addEventListener('mousedown', forwardViewportMouseEvent);
  nativeViewport?.addEventListener('mouseup', forwardViewportMouseEvent);
  nativeViewport?.addEventListener('mouseleave', forwardViewportMouseEvent);

  type TouchPointer = {
    identifier: number;
    startX: number;
    startY: number;
    lastY: number;
    moved: boolean;
    bufferType: 'normal' | 'alternate';
    wheelRemainder: number;
    longPressTimer: number | null;
    longPressed: boolean;
    selectionStarted: boolean;
    selectionActiveAtStart: boolean;
  };
  let touchPointer: TouchPointer | null = null;
  let lastTouchAt = 0;
  let lastPromptTapAt = 0;
  let activeBufferType = terminal.buffer.active.type;
  let touchSelection: TouchSelection | null = null;
  const screenRect = () => (
    surface.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect()
    ?? surface.getBoundingClientRect()
  );
  const terminalCellAtPoint = (clientX: number, clientY: number): TerminalCell | null => {
    const rect = screenRect();
    const buffer = terminal.buffer.active;
    return cellAtPoint(clientX, clientY, {
      cols: terminal.cols,
      rows: terminal.rows,
      bufferLength: buffer.length,
      viewportY: buffer.viewportY,
      rect,
    });
  };
  const showSelectionChipAt = (clientX: number, clientY: number) => {
    if (!touchSelection || !terminal.hasSelection()) return;
    const panel = surface.closest<HTMLElement>('.terminal-panel');
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const position = terminalSelectionChipPosition(clientX, clientY, rect);
    setSelectionChip({
      visible: true,
      ...position,
    });
  };
  const clearSelection = () => {
    touchSelection = null;
    terminal.clearSelection();
    if (nativeViewport) delete nativeViewport.dataset.touchSelection;
    setSelectionChip({ visible: false, x: 0, y: 0 });
  };
  const selectToCell = (extent: TerminalCell) => {
    if (!touchSelection) return;
    const selection = terminalSelectionRange(touchSelection.anchor, extent, terminal.cols);
    if (!selection) return;
    touchSelection.extent = extent;
    terminal.select(selection.start.col, selection.start.row, selection.length);
  };
  const selectionContainsCell = (cell: TerminalCell): boolean => {
    if (!touchSelection) return false;
    return terminalSelectionContainsCell(
      touchSelection.anchor,
      touchSelection.extent,
      cell,
      terminal.cols,
    );
  };
  const startWordSelection = (gesture: TouchPointer): boolean => {
    const cell = terminalCellAtPoint(gesture.startX, gesture.startY);
    const line = cell ? terminal.buffer.active.getLine(cell.row) : undefined;
    if (!cell || !line) return false;
    const cells = Array.from({ length: terminal.cols }, (_, col) => {
      const bufferCell = line.getCell(col);
      return {
        chars: bufferCell?.getChars() ?? '',
        width: bufferCell?.getWidth() ?? 1,
      };
    });
    const word = terminalWordBoundary(cells, cell.col);
    if (!word) return false;
    const anchor = {
      start: { col: word.start, row: cell.row },
      end: { col: word.start + word.length - 1, row: cell.row },
    };
    touchSelection = { anchor, extent: anchor.end };
    gesture.selectionStarted = true;
    if (nativeViewport) nativeViewport.dataset.touchSelection = 'active';
    terminal.select(anchor.start.col, anchor.start.row, word.length);
    // Match native selection menus by surfacing actions as soon as the
    // long-press resolves; pointer/touch release repositions the row.
    showSelectionChipAt(gesture.startX, gesture.startY);
    return true;
  };
  const cancelLongPress = (gesture: TouchPointer | null) => {
    if (gesture?.longPressTimer === null || gesture?.longPressTimer === undefined) return;
    window.clearTimeout(gesture.longPressTimer);
    gesture.longPressTimer = null;
  };
  const copyCurrentSelection = async () => {
    const text = terminal.getSelection();
    if (text) await navigator.clipboard.writeText(text);
  };
  copyTouchSelection.current = copyCurrentSelection;
  clearTouchSelection.current = clearSelection;

  const nativeRenderSubscription = terminal.onRender(refreshNativeScrollRange);
  const nativeResizeSubscription = terminal.onResize(() => {
    refreshNativeScrollRange();
    syncNativeScrollPosition(terminal.buffer.active.viewportY);
  });
  const nativeScrollSubscription = terminal.onScroll((line) => {
    refreshNativeScrollRange();
    syncNativeScrollPosition(line);
  });
  const nativeBufferSubscription = terminal.buffer.onBufferChange((buffer) => {
    activeBufferType = buffer.type;
    if (nativeViewport) nativeViewport.dataset.terminalBuffer = buffer.type;
    cancelLongPress(touchPointer);
    touchPointer = null;
    clearSelection();
    refreshNativeScrollRange();
    syncNativeScrollPosition(buffer.viewportY);
  });
  const selectionSubscription = terminal.onSelectionChange(() => {
    if (touchSelection && !terminal.hasSelection()) clearSelection();
    // Desktop copy-on-select: xterm's selection isn't a DOM selection, so cmd/ctrl+C
    // can't reach it. Mirror standard terminal behaviour — selecting copies.
    else if (!touchSelection && terminal.hasSelection()) {
      const text = terminal.getSelection();
      if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
    }
  });
  // Route OSC 52 (terminal clipboard writes — e.g. Claude Code's "c to copy") to the
  // browser clipboard; xterm drops it otherwise, so the copied text never leaves the VM.
  const osc52Subscription = terminal.parser.registerOscHandler(52, (payload) => {
    const encoded = payload.slice(payload.indexOf(";") + 1);
    try {
      const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      void navigator.clipboard.writeText(new TextDecoder().decode(bytes)).catch(() => undefined);
    } catch {
      // ignore malformed OSC 52 payloads
    }
    return true;
  });
  refreshNativeScrollRange();
  syncNativeScrollPosition(terminal.buffer.active.viewportY);

  // visualViewport geometry is the visibility truth. Focus and blur only
  // converge the textarea's inputmode around browser-initiated transitions.
  const showKeyboard = () => {
    if (!textarea) return;
    keyboardHideRequested = false;
    if (document.activeElement === textarea) textarea.blur();
    setTextareaInputMode('none');
    terminal.focus();
    if (document.activeElement !== textarea) textarea.focus({ preventScroll: true });
    setTextareaInputMode('text');
  };
  const hideKeyboard = () => {
    if (!textarea) return;
    keyboardHideRequested = keyboardUp;
    setTextareaInputMode('none');
    terminal.blur();
    if (document.activeElement === textarea) textarea.blur();
  };
  const toggleKeyboard = () => {
    if (keyboardUp) hideKeyboard();
    else showKeyboard();
  };
  const activatePromptKeyboard = (
    gesture: TouchPointer,
    clientX: number,
    clientY: number,
    event: Event,
  ): boolean => {
    if (
      gesture.moved
      || !window.matchMedia('(pointer: coarse)').matches
      || !isTerminalPromptTouch(clientY, screenRect(), terminal.rows)
    ) return false;
    const cell = terminalCellAtPoint(clientX, clientY);
    if (!cell) return false;
    const buffer = terminal.buffer.active;
    const visibleRows = Array.from({ length: terminal.rows }, (_, row) => (
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
    ));
    const inputRow = classifyTerminalInputRow(visibleRows, cell.row - buffer.viewportY);
    if (inputRow === 'outside') return false;
    if (event.cancelable) event.preventDefault();
    lastPromptTapAt = Date.now();
    if (keyboardUp) return true;
    if (touchSelection) clearSelection();
    showKeyboard();
    return true;
  };
  const activateTerminalChoice = (
    gesture: TouchPointer,
    clientX: number,
    clientY: number,
    event: Event,
  ): boolean => {
    if (gesture.moved || gesture.longPressed || !choiceMenuActiveRef.current) return false;
    const cell = terminalCellAtPoint(clientX, clientY);
    const line = cell ? terminal.buffer.active.getLine(cell.row) : undefined;
    const choice = line
      ? parseTerminalChoiceRow(line.translateToString(true))
      : null;
    if (!choice) return false;
    if (event.cancelable) event.preventDefault();
    lastPromptTapAt = Date.now();
    sendInput(`${choice.digits}\r`);
    return true;
  };
  const activateTerminalLink = (
    clientX: number,
    clientY: number,
    event: Event,
  ): boolean => {
    // xterm's linkifier is mouse-driven. Probe the released cell with a
    // synthetic hover so the addon's wrapped-row provider remains the one
    // source of truth for both mouse and touch hit testing.
    screen?.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX,
      clientY,
      view: window,
    }));
    if (!hoveredWebLink || !openTerminalWebLink(hoveredWebLink, onOpenPreview)) return false;
    // A tap may emit compatibility mouse events after release. The direct
    // touch activation wins and the matching follow-up is ignored.
    suppressedCompatibilityLink = {
      uri: hoveredWebLink,
      until: Date.now() + 1_000,
    };
    if (event.cancelable) event.preventDefault();
    return true;
  };
  const synthesizeAlternateWheel = (
    event: PointerEvent,
    gesture: TouchPointer,
    deltaY: number,
  ) => {
    if (!xtermElement) return;
    // iOS-natural content motion: an upward finger drag becomes a downward
    // wheel, revealing newer/lower alternate-screen content.
    const accumulated = accumulateTerminalTouchWheelLines(
      -deltaY,
      nativeRowHeight(),
      gesture.wheelRemainder,
    );
    gesture.wheelRemainder = accumulated.remainder;
    if (accumulated.lines === 0) return;
    const wheelDeltaY = Math.sign(accumulated.lines);
    const count = Math.abs(accumulated.lines);
    // xterm owns the mode-specific routing: alternate buffers become cursor
    // keys, while an enabled mouse protocol becomes a position-aware report.
    // xterm v6 emits at most one application sequence per DOM wheel event,
    // so replay one line-mode event for every accumulated renderer row.
    for (let index = 0; index < count; index += 1) {
      xtermElement.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        screenX: event.screenX,
        screenY: event.screenY,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: wheelDeltaY,
      }));
    }
  };
  const handlePointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      lastTouchAt = Date.now();
      programmaticScrollTop = null;
      nativeScrollInputUntil = Number.POSITIVE_INFINITY;
      const selectionActiveAtStart = touchSelection !== null && terminal.hasSelection();
      const gesture: TouchPointer = {
        identifier: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastY: event.clientY,
        moved: false,
        bufferType: activeBufferType,
        wheelRemainder: 0,
        longPressTimer: null,
        longPressed: false,
        selectionStarted: false,
        selectionActiveAtStart,
      };
      touchPointer = gesture;
      if (selectionActiveAtStart) {
        setSelectionChip({ visible: false, x: 0, y: 0 });
      } else {
        gesture.longPressTimer = window.setTimeout(() => {
          gesture.longPressTimer = null;
          if (touchPointer === gesture && !gesture.moved) {
            gesture.longPressed = true;
            startWordSelection(gesture);
          }
        }, TERMINAL_TOUCH_LONG_PRESS_MS);
      }
      if (activeBufferType === 'alternate' || selectionActiveAtStart) {
        event.preventDefault();
        try {
          nativeViewport?.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is a best-effort guard for drags leaving the grid.
        }
      }
      return;
    }
    if (
      event.pointerType === 'mouse'
      && lastPromptTapAt > 0
      && Date.now() - lastPromptTapAt < 1_500
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    terminal.focus();
  };
  const handlePointerMove = (event: PointerEvent) => {
    const gesture = touchPointer;
    if (event.pointerType !== 'touch' || gesture?.identifier !== event.pointerId) return;
    if (
      !gesture.moved
      && touchGestureMoved(gesture.startX, gesture.startY, event.clientX, event.clientY)
    ) {
      gesture.moved = true;
      cancelLongPress(gesture);
    }
    if (gesture.selectionStarted || gesture.selectionActiveAtStart) {
      event.preventDefault();
      const extent = terminalCellAtPoint(event.clientX, event.clientY);
      if (extent) selectToCell(extent);
      showSelectionChipAt(event.clientX, event.clientY);
      return;
    }
    if (gesture.bufferType !== 'alternate') return;
    event.preventDefault();
    if (!gesture.moved) return;
    const previousY = gesture.lastY;
    gesture.lastY = event.clientY;
    synthesizeAlternateWheel(event, gesture, event.clientY - previousY);
  };
  const handlePointerUp = (event: PointerEvent) => {
    const gesture = touchPointer;
    cancelLongPress(gesture);
    touchPointer = null;
    if (event.pointerType === 'touch') {
      nativeScrollInputUntil = performance.now() + 3_000;
    }
    if (event.pointerType === 'touch' && gesture) {
      try {
        if (nativeViewport?.hasPointerCapture(event.pointerId)) {
          nativeViewport.releasePointerCapture(event.pointerId);
        }
      } catch {
        // The browser may have released capture before pointerup.
      }
    }
    if (
      event.pointerType === 'touch'
      && gesture?.identifier === event.pointerId
      && (gesture.selectionStarted || gesture.selectionActiveAtStart)
    ) {
      if (activatePromptKeyboard(gesture, event.clientX, event.clientY, event)) return;
      event.preventDefault();
      const releasedCell = terminalCellAtPoint(event.clientX, event.clientY);
      if (
        gesture.selectionActiveAtStart
        && !gesture.moved
        && (!releasedCell || !selectionContainsCell(releasedCell))
      ) {
        clearSelection();
      } else {
        if (releasedCell && gesture.moved) selectToCell(releasedCell);
        showSelectionChipAt(event.clientX, event.clientY);
      }
      return;
    }
    if (
      event.pointerType === 'touch'
      && gesture?.identifier === event.pointerId
      && !gesture.moved
    ) {
      if (activateTerminalLink(event.clientX, event.clientY, event)) return;
      if (activateTerminalChoice(
        gesture,
        event.clientX,
        event.clientY,
        event,
      )) return;
      activatePromptKeyboard(gesture, event.clientX, event.clientY, event);
    }
  };
  const handlePointerCancel = (event: PointerEvent) => {
    if (event.pointerType === 'touch' && touchPointer?.identifier === event.pointerId) {
      const gesture = touchPointer;
      cancelLongPress(gesture);
      try {
        if (nativeViewport?.hasPointerCapture(event.pointerId)) {
          nativeViewport.releasePointerCapture(event.pointerId);
        }
      } catch {
        // The browser may have already released capture for the cancellation.
      }
      touchPointer = null;
      nativeScrollInputUntil = performance.now() + 3_000;
      if (activatePromptKeyboard(gesture, event.clientX, event.clientY, event)) return;
      if (gesture.selectionStarted || gesture.selectionActiveAtStart) {
        showSelectionChipAt(event.clientX, event.clientY);
      }
    }
  };
  const handleSelectionTouchMove = (event: TouchEvent) => {
    if (touchSelection) event.preventDefault();
  };
  const handleTouchEnd = (event: TouchEvent) => {
    const gesture = touchPointer;
    const released = event.changedTouches[0];
    if (!gesture || !released) return;
    if (
      !gesture.selectionStarted
      && !gesture.selectionActiveAtStart
      && !gesture.moved
      && activateTerminalLink(released.clientX, released.clientY, event)
    ) {
      cancelLongPress(gesture);
      touchPointer = null;
      nativeScrollInputUntil = performance.now() + 3_000;
      return;
    }
    if (
      !gesture.selectionStarted
      && !gesture.selectionActiveAtStart
      && activateTerminalChoice(
        gesture,
        released.clientX,
        released.clientY,
        event,
      )
    ) {
      cancelLongPress(gesture);
      touchPointer = null;
      nativeScrollInputUntil = performance.now() + 3_000;
      return;
    }
    if (activatePromptKeyboard(gesture, released.clientX, released.clientY, event)) {
      cancelLongPress(gesture);
      touchPointer = null;
      nativeScrollInputUntil = performance.now() + 3_000;
      return;
    }
    if (
      !touchSelection
      || (!gesture.selectionStarted && !gesture.selectionActiveAtStart)
    ) return;
    event.preventDefault();
    cancelLongPress(gesture);
    touchPointer = null;
    nativeScrollInputUntil = performance.now() + 3_000;
    try {
      if (nativeViewport?.hasPointerCapture(gesture.identifier)) {
        nativeViewport.releasePointerCapture(gesture.identifier);
      }
    } catch {
      // WebKit may end the touch without emitting a matching pointerup.
    }
    const releasedCell = terminalCellAtPoint(released.clientX, released.clientY);
    if (
      gesture.selectionActiveAtStart
      && !gesture.moved
      && (!releasedCell || !selectionContainsCell(releasedCell))
    ) {
      clearSelection();
    } else {
      if (releasedCell && gesture.moved) selectToCell(releasedCell);
      showSelectionChipAt(released.clientX, released.clientY);
    }
  };
  const handleCompatibilityMouseTail = (event: MouseEvent) => {
    if (!suppressCompatibilityMouse(
      lastTouchAt,
      lastPromptTapAt,
      touchSelection !== null,
      Date.now(),
    )) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const handleKeyboardRequest = () => toggleKeyboard();
  const handlePasteRequest = () => {
    void pasteFromClipboard();
  };
  const handleContextMenu = (event: MouseEvent) => {
    // A touch long-press synthesizes a contextmenu; suppress it (mobile uses the
    // selection chip). On desktop, let the native menu (Copy/Paste) show — never
    // auto-paste on right-click.
    if (Date.now() - lastTouchAt < 1_500) event.preventDefault();
  };
  surface.addEventListener('pointerdown', handlePointerDown);
  surface.addEventListener('pointermove', handlePointerMove);
  surface.addEventListener('pointerup', handlePointerUp);
  surface.addEventListener('pointercancel', handlePointerCancel);
  surface.addEventListener('touchmove', handleSelectionTouchMove, { passive: false });
  surface.addEventListener('touchend', handleTouchEnd, { passive: false });
  surface.addEventListener('mousedown', handleCompatibilityMouseTail, { capture: true });
  surface.addEventListener('mouseup', handleCompatibilityMouseTail, { capture: true });
  surface.addEventListener('click', handleCompatibilityMouseTail, { capture: true });
  textarea?.addEventListener('focus', handleTextareaFocus);
  textarea?.addEventListener('blur', handleTextareaBlur);
  surface.addEventListener('contextmenu', handleContextMenu);
  window.addEventListener(TERMINAL_KEYBOARD_EVENT, handleKeyboardRequest);
  window.addEventListener(TERMINAL_PASTE_EVENT, handlePasteRequest);

  return () => {
    disposed = true;
    cancelLongPress(touchPointer);
    if (copyTouchSelection.current === copyCurrentSelection) copyTouchSelection.current = null;
    if (clearTouchSelection.current === clearSelection) clearTouchSelection.current = null;
    if (pasteHintTimeout !== undefined) window.clearTimeout(pasteHintTimeout);
    nativeViewport?.removeEventListener('scroll', handleNativeViewportScroll);
    nativeViewport?.removeEventListener('mousemove', forwardViewportMouseEvent);
    nativeViewport?.removeEventListener('mousedown', forwardViewportMouseEvent);
    nativeViewport?.removeEventListener('mouseup', forwardViewportMouseEvent);
    nativeViewport?.removeEventListener('mouseleave', forwardViewportMouseEvent);
    nativeRenderSubscription.dispose();
    nativeResizeSubscription.dispose();
    nativeScrollSubscription.dispose();
    nativeBufferSubscription.dispose();
    selectionSubscription.dispose();
    osc52Subscription.dispose();
    surface.removeEventListener('pointerdown', handlePointerDown);
    surface.removeEventListener('pointermove', handlePointerMove);
    surface.removeEventListener('pointerup', handlePointerUp);
    surface.removeEventListener('pointercancel', handlePointerCancel);
    surface.removeEventListener('touchmove', handleSelectionTouchMove);
    surface.removeEventListener('touchend', handleTouchEnd);
    surface.removeEventListener('mousedown', handleCompatibilityMouseTail, { capture: true });
    surface.removeEventListener('mouseup', handleCompatibilityMouseTail, { capture: true });
    surface.removeEventListener('click', handleCompatibilityMouseTail, { capture: true });
    textarea?.removeEventListener('focus', handleTextareaFocus);
    textarea?.removeEventListener('blur', handleTextareaBlur);
    surface.removeEventListener('contextmenu', handleContextMenu);
    window.removeEventListener(TERMINAL_KEYBOARD_EVENT, handleKeyboardRequest);
    window.removeEventListener(TERMINAL_PASTE_EVENT, handlePasteRequest);
    stopObservingKeyboardGeometry();
    surface.removeEventListener('paste', handleNativePaste, { capture: true });
    terminal.attachCustomKeyEventHandler(() => true);
    webLinksAddon.dispose();
    nativeScrollSpacer.remove();
    if (nativeViewport) {
      delete nativeViewport.dataset.nativeTouchScroll;
      delete nativeViewport.dataset.terminalBuffer;
      delete nativeViewport.dataset.touchSelection;
    }
  };
}

