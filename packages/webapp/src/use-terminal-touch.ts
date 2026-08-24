import { useCallback, useEffect, useRef, useState } from 'react';
import { bindTerminalPaste } from './terminal-paste-binding';
import {
  bindTerminalTouch,
  type SelectionChip,
  type TerminalTouchOptions,
} from './terminal-touch-controller';

export { openTerminalWebLink } from './terminal-touch-controller';

export function useTerminalTouch({
  terminal,
  surface,
  viewportEl,
  sendInput,
  active,
  choiceMenuActiveRef,
  onOpenPreview,
}: TerminalTouchOptions) {
  const pasteHintShown = useRef(false);
  const copyTouchSelection = useRef<(() => Promise<void>) | null>(null);
  const clearTouchSelection = useRef<(() => void) | null>(null);
  const [showPasteHint, setShowPasteHint] = useState(false);
  const [selectionChip, setSelectionChip] = useState<SelectionChip>({
    visible: false,
    x: 0,
    y: 0,
  });

  const copySelection = useCallback(async () => {
    await copyTouchSelection.current?.();
  }, []);
  const deselectSelection = useCallback(() => {
    clearTouchSelection.current?.();
  }, []);

  // The callback props are effect EVENTS, not lifecycle. A caller that rebuilds
  // its arrows every render (CloudApp does) must not tear these bindings down
  // and put them back: the controller suppresses xterm's own paste path, so a
  // paste landing in the gap is gone. Hold the newest ones in a ref and give
  // the effects identities that never change.
  const latest = useRef({ onOpenPreview, sendInput, viewportEl });
  latest.current = { onOpenPreview, sendInput, viewportEl };
  const openPreview = useCallback(
    (port: number) => latest.current.onOpenPreview?.(port) ?? false,
    [],
  );
  const send = useCallback((data: string) => {
    latest.current.sendInput(data);
  }, []);
  const viewport = useCallback(() => latest.current.viewportEl?.() ?? null, []);

  useEffect(() => bindTerminalTouch({
    terminal,
    surface,
    viewportEl: viewport,
    sendInput: send,
    active,
    choiceMenuActiveRef,
    onOpenPreview: openPreview,
    pasteHintShown,
    copyTouchSelection,
    clearTouchSelection,
    setShowPasteHint,
    setSelectionChip,
  }), [
    active,
    choiceMenuActiveRef,
    openPreview,
    send,
    surface,
    terminal,
    viewport,
  ]);

  // Keyboard paste binds on its own, shorter dep list. The pane going inactive
  // and active again is a normal tab switch; it must not open a window where a
  // paste has no listener.
  useEffect(
    () => bindTerminalPaste({ terminal, surface, sendInput: send }),
    [send, surface, terminal],
  );

  return {
    selectionChip,
    copySelection,
    deselectSelection,
    showPasteHint,
  };
}
