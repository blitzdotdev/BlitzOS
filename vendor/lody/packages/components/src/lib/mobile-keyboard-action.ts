export const MOBILE_KEYBOARD_ACTIONS = ['send', 'newline'] as const;

export type MobileKeyboardAction = (typeof MOBILE_KEYBOARD_ACTIONS)[number];
export type MobileKeyboardEnterKeyHint = 'send' | 'enter';

export function isMobileKeyboardAction(value: unknown): value is MobileKeyboardAction {
  return value === 'send' || value === 'newline';
}

export function resolveMobileKeyboardEnterKeyHint(
  action: MobileKeyboardAction,
  isMobile: boolean
): MobileKeyboardEnterKeyHint {
  return isMobile && action === 'newline' ? 'enter' : 'send';
}

export function shouldSubmitOnEnterForMobileKeyboardAction({
  action,
  isMobile,
  shiftKey,
}: {
  action: MobileKeyboardAction;
  isMobile: boolean;
  shiftKey: boolean;
}): boolean {
  if (shiftKey) {
    return false;
  }

  return !(isMobile && action === 'newline');
}
