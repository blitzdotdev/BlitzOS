import { FileTypeIcon } from './FileTypeIcon';
import {
  CodexIcon,
  FileIcon,
  FolderIcon,
  GenericProviderIcon,
  ShellIcon,
} from './WebAppIcons';
import type { TerminalAgent } from './protocol';

export type WebAppSessionType = TerminalAgent | 'terminal' | 'file' | 'preview' | 'panel';

/** One glyph per session kind. Tab strips, the session rail and the new-tab
 * menu all draw a session through this, so a kind looks the same everywhere. */
export function SessionTypeIcon({
  type,
  className,
  filePath,
  panel,
}: {
  type: WebAppSessionType | 'terminal';
  className: string;
  filePath?: string;
  panel?: 'files' | 'previews' | 'connections';
}) {
  if (type === 'panel') {
    if (panel === 'previews') {
      return <span className={`${className} mi-preview`} aria-hidden="true" />;
    }
    return panel === 'connections'
      ? <GenericProviderIcon className={className} />
      : <FolderIcon className={className} />;
  }
  if (type === 'claude') return <span className={`${className} mi-claude`} aria-hidden="true" />;
  if (type === 'opencode') return <span className={`${className} mi-opencode`} aria-hidden="true" />;
  if (type === 'pi') return <span className={`${className} mi-pi`} aria-hidden="true" />;
  if (type === 'kimi') return <span className={`${className} mi-kimi`} aria-hidden="true" />;
  if (type === 'prime') return <GenericProviderIcon className={className} />;
  if (type === 'terminal') return <ShellIcon className={className} />;
  if (type === 'preview') return <span className={`${className} mi-preview`} aria-hidden="true" />;
  if (type === 'file') {
    return filePath
      ? <FileTypeIcon className={className} filePath={filePath} />
      : <FileIcon className={className} />;
  }
  if (type === 'codex') return <CodexIcon className={className} />;
  return <GenericProviderIcon className={className} />;
}
