import { Fragment, useEffect, useRef, useState, type DragEvent } from 'react';
import { CodexIcon, FileIcon, FolderIcon, GenericProviderIcon, ShellIcon } from './WebAppIcons';
import { FileTypeIcon } from './FileTypeIcon';
import { previewLinkLabel, type LivePort, type PreviewLink } from './preview';
import type { TerminalAgent } from './protocol';

export type WebAppSessionType = TerminalAgent | 'terminal' | 'chat' | 'file' | 'preview' | 'panel';
export type SpawnSessionType = 'claude' | 'codex' | 'terminal' | 'chat';

export const SPAWN_SESSION_LABELS = {
  chat: 'Chat',
  claude: 'Claude',
  codex: 'Codex',
  terminal: 'Terminal',
} satisfies Record<SpawnSessionType, string>;

const SPAWN_SESSION_TYPES: SpawnSessionType[] = [
  'chat',
  'claude',
  'codex',
  'terminal',
];

export type WebAppTabModel = {
  id: string;
  label: string;
  agent: WebAppSessionType;
  pending: boolean;
  dirty?: boolean;
  filePath?: string;
  title?: string;
  /** Which panel a `panel` tab shows, so the strip can pick its icon. */
  panel?: 'files' | 'previews' | 'connections';
};

type WebAppHeaderProps = {
  tabs: WebAppTabModel[];
  activeSessionId: string;
  sessionBusy: boolean;
  terminalDisabled: boolean;
  mobile?: boolean;
  paneStrips?: boolean;
  drawerOpen?: boolean;
  onOpenDrawer?: () => void;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onSpawn: (type: SpawnSessionType) => void;
  livePorts?: LivePort[];
  previewLinks?: PreviewLink[];
  onOpenPreview?: (port: number) => boolean;
  onOpenPreviewLink?: (url: string, title: string) => boolean;
  onMenuOpenChange?: (open: boolean) => void;
  /** Names the tab list for assistive tech; each pane gets its own strip. */
  stripLabel?: string;
  /** The side pane is a destination, not a spawn point. */
  spawnable?: boolean;
  onTabDragStart?: (sessionId: string, event: DragEvent<HTMLElement>) => void;
  onTabDragEnd?: () => void;
  /** `undefined` hides the insertion bar, `null` puts it after the last tab,
   * and a session id puts it in front of that tab. */
  insertBeforeId?: string | null;
  draggingSessionId?: string | null;
};

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
  if (type === 'chat') return <span className={`${className} mi-chat`} aria-hidden="true" />;
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

export function WebAppHeader({
  tabs,
  activeSessionId,
  sessionBusy,
  terminalDisabled,
  mobile = false,
  paneStrips = false,
  drawerOpen = false,
  onOpenDrawer = () => undefined,
  onSelect,
  onClose,
  onSpawn,
  livePorts = [],
  previewLinks = [],
  onOpenPreview = () => false,
  onOpenPreviewLink = () => false,
  onMenuOpenChange = () => undefined,
  stripLabel = 'Workspace sessions',
  spawnable = true,
  onTabDragStart,
  onTabDragEnd,
  insertBeforeId,
  draggingSessionId = null,
}: WebAppHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const newTabControl = useRef<HTMLDivElement>(null);
  const newSessionButton = useRef<HTMLButtonElement>(null);
  const tabstrip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      // SAFETY: Browser pointer-event targets used for DOM containment are Nodes.
      if (!newTabControl.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        onMenuOpenChange(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        onMenuOpenChange(false);
      }
    };
    window.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen, onMenuOpenChange]);

  useEffect(() => {
    const active = [...(tabstrip.current?.querySelectorAll<HTMLElement>('.webapp-tab-cell') ?? [])]
      .find((cell) => cell.dataset.sessionId === activeSessionId);
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeSessionId, tabs.length]);

  const spawnSession = (agent: SpawnSessionType) => {
    setMenuOpen(false);
    onMenuOpenChange(false);
    onSpawn(agent);
    newSessionButton.current?.focus();
  };
  const openPreview = (port: number) => {
    setMenuOpen(false);
    onMenuOpenChange(false);
    onOpenPreview(port);
    newSessionButton.current?.focus();
  };
  const openPreviewLink = (url: string, title: string) => {
    setMenuOpen(false);
    onMenuOpenChange(false);
    onOpenPreviewLink(url, title);
    newSessionButton.current?.focus();
  };

  return (
    <header className="webapp-header">
      <div className="webapp-header-main">
        {mobile && (
          <button
            className="webapp-drawer-open"
            type="button"
            aria-label="Open workspace navigation"
            aria-controls="webapp-navigation-drawer"
            aria-expanded={drawerOpen}
            onClick={onOpenDrawer}
          ><span aria-hidden="true">☰</span></button>
        )}
        {!paneStrips && (
          <>
            <div className="webapp-tabstrip" ref={tabstrip} role="tablist" aria-label={stripLabel}>
            {tabs.map((tab) => {
              const active = tab.id === activeSessionId;
              return (
                <Fragment key={tab.id}>
                {insertBeforeId === tab.id && (
                  <span className="webapp-tab-insert" aria-hidden="true" />
                )}
                <div
                  className={`webapp-tab-cell${active ? ' webapp-tab-cell--active' : ''}${
                    draggingSessionId === tab.id ? ' webapp-tab-cell--dragging' : ''}`}
                  data-session-id={tab.id}
                >
                  <button
                    className="webapp-tab-select"
                    type="button"
                    role="tab"
                    aria-selected={active}
                    title={tab.title ?? tab.label}
                    draggable={onTabDragStart !== undefined}
                    onDragStart={(event) => onTabDragStart?.(tab.id, event)}
                    onDragEnd={() => onTabDragEnd?.()}
                    onClick={() => onSelect(tab.id)}
                  >
                    <SessionTypeIcon
                      type={tab.agent}
                      className="webapp-tab-icon"
                      filePath={tab.filePath}
                      panel={tab.panel}
                    />
                    <span className="webapp-tab-label">{tab.label}</span>
                    {tab.dirty && <span className="webapp-tab-dirty" aria-label="Unsaved changes">•</span>}
                  </button>
                  {active && (
                    <button
                      className="webapp-tab-close"
                      type="button"
                      aria-label={`Close ${tab.label}`}
                      title={tab.pending
                        ? 'Archiving session…'
                        : tab.agent === 'file' ? 'Close file' : 'Archive session'}
                      disabled={tab.pending}
                      onClick={() => onClose(tab.id)}
                    >×</button>
                  )}
                </div>
                </Fragment>
              );
            })}
            {insertBeforeId === null && (
              <span className="webapp-tab-insert" aria-hidden="true" />
            )}
            </div>
            {spawnable && <div
              className="webapp-new-tab-control"
              ref={newTabControl}
              role="group"
              aria-label="New session"
            >
              <button
                ref={newSessionButton}
                className="webapp-new-tab-spawn"
                type="button"
                aria-label="New session"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={terminalDisabled}
                title={sessionBusy ? 'Starting…' : 'New session'}
                onClick={() => setMenuOpen((open) => {
                  onMenuOpenChange(!open);
                  return !open;
                })}
              >
                <span aria-hidden="true">+</span>
              </button>
              <div className="webapp-agent-menu" role="menu" hidden={!menuOpen}>
                {SPAWN_SESSION_TYPES.map((agent) => (
                  <button type="button" role="menuitem" key={agent} onClick={() => spawnSession(agent)}>
                    <SessionTypeIcon type={agent} className="webapp-new-menu-icon" />
                    {SPAWN_SESSION_LABELS[agent]}
                  </button>
                ))}
                {(livePorts.length > 0 || previewLinks.length > 0) && (
                  <>
                    <div className="webapp-agent-menu__separator" role="separator" />
                    {livePorts.map((entry) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={entry.port}
                        onClick={() => openPreview(entry.port)}
                      >
                        <SessionTypeIcon type="preview" className="webapp-new-menu-icon" />
                        <span>:{entry.port}</span>
                        <span className="webapp-agent-menu__process">{entry.process}</span>
                      </button>
                    ))}
                    {previewLinks.map((entry) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={entry.url}
                        onClick={() => openPreviewLink(entry.url, entry.title)}
                      >
                        <SessionTypeIcon type="preview" className="webapp-new-menu-icon" />
                        <span>{previewLinkLabel(entry.url, entry.title)}</span>
                        <span className="webapp-agent-menu__process">link</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>}
          </>
        )}

      </div>
    </header>
  );
}
