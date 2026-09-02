import {
  CodexIcon,
  GenericProviderIcon,
  ShellIcon,
} from './WebAppIcons';
import type { TerminalAgent } from './protocol';

export type WebAppSessionType = TerminalAgent | 'terminal' | 'preview' | 'panel';

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
