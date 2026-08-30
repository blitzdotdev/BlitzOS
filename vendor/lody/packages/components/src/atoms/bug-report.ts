import { atom } from 'jotai';

/**
 * Controls the bug-report dialog. Opened from both the sidebar help menu and
 * the settings page, so the dialog itself is mounted once in MainLayout.
 */
export const bugReportDialogOpenAtom = atom(false);
