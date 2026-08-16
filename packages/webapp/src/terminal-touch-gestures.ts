import { TERMINAL_TOUCH_MOVE_THRESHOLD_PX } from './terminal-touch.js';

export type ClipboardReadDecision = 'paste' | 'hint' | 'ignore';

export function clipboardReadDecision(
  disposed: boolean,
  text: string,
  failed: boolean,
): ClipboardReadDecision {
  if (disposed) return 'ignore';
  if (failed) return 'hint';
  return text ? 'paste' : 'ignore';
}

export function touchGestureMoved(
  startX: number,
  startY: number,
  clientX: number,
  clientY: number,
): boolean {
  return Math.hypot(clientX - startX, clientY - startY) > TERMINAL_TOUCH_MOVE_THRESHOLD_PX;
}

export function suppressCompatibilityMouse(
  lastTouchAt: number,
  lastPromptTapAt: number,
  hasTouchSelection: boolean,
  now: number,
): boolean {
  const recentTouch = now - lastTouchAt < 1_500;
  const recentPromptTap = lastPromptTapAt > 0 && now - lastPromptTapAt < 1_500;
  return recentTouch && (hasTouchSelection || recentPromptTap);
}
