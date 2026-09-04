import {
  CodexIcon,
  GenericProviderIcon,
  ShellIcon,
} from './WebAppIcons';
import type { TerminalAgent } from './protocol';

export type WebAppSessionType = TerminalAgent | 'terminal' | 'preview' | 'panel';

/**
 * One workspace tab as a tab strip draws it: label, glyph and the few flags a
 * strip decorates a tab with.
 *
 * It lived beside the native strip until that strip was deleted
 * (plans/LODY-TERMINAL-TABS.md §4.6, "PR 2 — the deletion"). Its readers are now
 * `CloudApp`, which builds the list, and `lody/surface-tabs.ts`, which turns it
 * into the vendored strip's tabs — so it belongs beside the glyph both of them
 * draw it with, and not in a file named after a header that no longer exists.
 */
export type WebAppTabModel = {
  id: string;
  label: string;
  agent: WebAppSessionType;
  pending: boolean;
  customTitle?: string;
  renameable?: boolean;
  dirty?: boolean;
  filePath?: string;
  title?: string;
  /** Which panel a `panel` tab shows, so the strip can pick its icon. One
   * panel is left since the Files and teenyapps panels retired. */
  panel?: 'connections';
};

/** One glyph per session kind. Tab strips, the session rail and the new-tab
 * menu all draw a session through this, so a kind looks the same everywhere. */
export function SessionTypeIcon({
  type,
  className,
}: {
  type: WebAppSessionType | 'terminal';
  className: string;
  /** Which panel a `panel` tab shows. One panel is left, so one glyph. */
  panel?: 'connections';
}) {
  if (type === 'panel') return <GenericProviderIcon className={className} />;
  if (type === 'claude') return <span className={`${className} mi-claude`} aria-hidden="true" />;
  if (type === 'opencode') return <span className={`${className} mi-opencode`} aria-hidden="true" />;
  if (type === 'pi') return <span className={`${className} mi-pi`} aria-hidden="true" />;
  if (type === 'kimi') return <span className={`${className} mi-kimi`} aria-hidden="true" />;
  if (type === 'prime') return <GenericProviderIcon className={className} />;
  if (type === 'terminal') return <ShellIcon className={className} />;
  if (type === 'preview') return <span className={`${className} mi-preview`} aria-hidden="true" />;
  if (type === 'codex') return <CodexIcon className={className} />;
  return <GenericProviderIcon className={className} />;
}
