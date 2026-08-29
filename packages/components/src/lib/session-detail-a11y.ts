export const SESSION_DETAIL_MAIN_CONTENT_ID = 'session-detail-main-content';
export const SESSION_DETAIL_EDITOR_CONTENT_ID = 'session-detail-editor-content';

export function getSessionDetailSkipTargetId(hasEditorSurface: boolean): string {
  return hasEditorSurface ? SESSION_DETAIL_EDITOR_CONTENT_ID : SESSION_DETAIL_MAIN_CONTENT_ID;
}

export function getSessionDetailSkipLinkClassName(): string {
  return [
    'sr-only',
    'focus:not-sr-only',
    'focus:fixed',
    'focus:left-3',
    'focus:top-3',
    'focus:z-[var(--z-tooltip)]',
    'focus:rounded-md',
    'focus:border',
    'focus:border-border',
    'focus:bg-background',
    'focus:px-3',
    'focus:py-2',
    'focus:text-sm',
    'focus:font-medium',
    'focus:text-foreground',
    'focus:shadow-md',
  ].join(' ');
}

export function getSessionDetailTouchIconButtonClassName(...classNames: string[]): string {
  return ['h-11', 'w-11', 'shrink-0', ...classNames.filter(Boolean)].join(' ');
}
