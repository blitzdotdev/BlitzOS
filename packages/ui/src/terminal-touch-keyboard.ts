import type { VisualViewportGeometry } from './mobile-cockpit.js';

export const KEYBOARD_VIEWPORT_THRESHOLD_PX = 90;

type KeyboardGeometryUpdateInput = {
  baselineHeight: number;
  keyboardUp: boolean;
  keyboardHideRequested: boolean;
  textareaFocused: boolean;
  geometry: Pick<VisualViewportGeometry, 'height' | 'source'>;
};

type KeyboardGeometryUpdate = {
  baselineHeight: number;
  keyboardUp: boolean;
  keyboardHideRequested: boolean;
  resetInputMode: boolean;
};

export function keyboardGeometryUpdate({
  baselineHeight,
  keyboardUp,
  keyboardHideRequested,
  textareaFocused,
  geometry,
}: KeyboardGeometryUpdateInput): KeyboardGeometryUpdate {
  const nextBaselineHeight = (
    baselineHeight === 0
    || (!textareaFocused && (geometry.source === 'orientation' || geometry.source === 'window'))
  )
    ? geometry.height
    : Math.max(baselineHeight, geometry.height);
  const nextKeyboardUp = nextBaselineHeight - geometry.height > KEYBOARD_VIEWPORT_THRESHOLD_PX;
  const keyboardClosed = keyboardUp && !nextKeyboardUp;
  return {
    baselineHeight: nextBaselineHeight,
    keyboardUp: nextKeyboardUp,
    keyboardHideRequested: keyboardClosed ? false : keyboardHideRequested,
    resetInputMode: keyboardClosed && !keyboardHideRequested,
  };
}
