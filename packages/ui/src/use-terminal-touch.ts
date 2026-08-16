import { useCallback, useEffect, useRef, useState } from 'react';
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

  useEffect(() => bindTerminalTouch({
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
  }), [
    active,
    choiceMenuActiveRef,
    onOpenPreview,
    sendInput,
    surface,
    terminal,
    viewportEl,
  ]);

  return {
    selectionChip,
    copySelection,
    deselectSelection,
    showPasteHint,
  };
}
