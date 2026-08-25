import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  ArchiveIcon,
  CodexIcon,
  FileIcon,
  FolderIcon,
  GenericProviderIcon,
  RestoreIcon,
  ShellIcon,
  TrashIcon,
} from './WebAppIcons';
import { FileTypeIcon } from './FileTypeIcon';
import { previewLinkLabel, type LivePort, type PreviewLink } from './preview';
import type { TerminalAgent } from './protocol';
import { SESSION_TITLE_MAX_LENGTH } from './storage';

export { SESSION_TITLE_MAX_LENGTH } from './storage';

export type WebAppSessionType = TerminalAgent | 'terminal' | 'chat' | 'file' | 'preview' | 'panel';
export type SpawnSessionType = 'claude' | 'codex' | 'terminal' | 'chat';

function isManagedSessionTab(tab: WebAppTabModel): boolean {
  return tab.agent !== 'file' && tab.agent !== 'preview' && tab.agent !== 'panel';
}

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
  customTitle?: string;
  renameable?: boolean;
  dirty?: boolean;
  filePath?: string;
  title?: string;
  /** Which panel a `panel` tab shows, so the strip can pick its icon. */
  panel?: 'files' | 'previews' | 'connections';
};

type WebAppHeaderProps = {
  tabs: WebAppTabModel[];
  archivedTabs?: WebAppTabModel[];
  activeSessionId: string;
  sessionBusy: boolean;
  terminalDisabled: boolean;
  mobile?: boolean;
  paneStrips?: boolean;
  drawerOpen?: boolean;
  onOpenDrawer?: () => void;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onRename?: (sessionId: string, title: string | undefined) => void;
  onArchive?: (sessionId: string) => void;
  onDelete?: (sessionId: string) => void;
  onRestore?: (sessionId: string) => void;
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
  archivedTabs = [],
  activeSessionId,
  sessionBusy,
  terminalDisabled,
  mobile = false,
  paneStrips = false,
  drawerOpen = false,
  onOpenDrawer = () => undefined,
  onSelect,
  onClose,
  onRename,
  onArchive,
  onDelete,
  onRestore,
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
  const [archiveMenuOpen, setArchiveMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    left: number;
    top: number;
  } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const newTabControl = useRef<HTMLDivElement>(null);
  const archiveControl = useRef<HTMLDivElement>(null);
  const contextMenuElement = useRef<HTMLDivElement>(null);
  const newSessionButton = useRef<HTMLButtonElement>(null);
  const tabstrip = useRef<HTMLDivElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameFinished = useRef(false);

  useEffect(() => {
    if (!menuOpen && !archiveMenuOpen && !contextMenu) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      // SAFETY: Browser pointer-event targets used for DOM containment are Nodes.
      const target = event.target as Node;
      if (!newTabControl.current?.contains(target)) {
        setMenuOpen(false);
        onMenuOpenChange(false);
      }
      if (!archiveControl.current?.contains(target)) setArchiveMenuOpen(false);
      if (!contextMenuElement.current?.contains(target)) setContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setArchiveMenuOpen(false);
        setContextMenu(null);
        onMenuOpenChange(false);
      }
    };
    window.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [archiveMenuOpen, contextMenu, menuOpen, onMenuOpenChange]);

  useEffect(() => {
    const active = [...(tabstrip.current?.querySelectorAll<HTMLElement>('.webapp-tab-cell') ?? [])]
      .find((cell) => cell.dataset.sessionId === activeSessionId);
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeSessionId, tabs.length]);

  useEffect(() => {
    renameInput.current?.focus();
    renameInput.current?.select();
  }, [renaming?.id]);

  const beginRename = (tab: WebAppTabModel) => {
    if (!tab.renameable || !onRename) return;
    setContextMenu(null);
    renameFinished.current = false;
    setRenaming({ id: tab.id, value: tab.customTitle ?? tab.label });
  };
  const finishRename = (tab: WebAppTabModel) => {
    if (!renaming || renaming.id !== tab.id || renameFinished.current) return;
    renameFinished.current = true;
    setRenaming(null);
    const title = renaming.value.trim() || undefined;
    if (title !== (tab.customTitle ?? tab.label)) onRename?.(tab.id, title);
  };
  const cancelRename = () => {
    renameFinished.current = true;
    setRenaming(null);
  };

  const spawnSession = (agent: SpawnSessionType) => {
    setMenuOpen(false);
    onMenuOpenChange(false);
    onSpawn(agent);
    newSessionButton.current?.focus();
  };
  const selectedContextTab = contextMenu
    ? tabs.find((tab) => tab.id === contextMenu.tabId) ?? null
    : null;
  const openContextMenu = (event: ReactMouseEvent, tab: WebAppTabModel) => {
    if (
      !isManagedSessionTab(tab)
      || (!onArchive && !onDelete && (!tab.renameable || !onRename))
    ) return;
    event.preventDefault();
    onSelect(tab.id);
    setMenuOpen(false);
    setArchiveMenuOpen(false);
    setContextMenu({
      tabId: tab.id,
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - 190)),
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - 140)),
    });
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
                  onContextMenu={(event) => openContextMenu(event, tab)}
                >
                  {renaming?.id === tab.id ? (
                    <div className="webapp-tab-select webapp-tab-select--editing">
                      <SessionTypeIcon
                        type={tab.agent}
                        className="webapp-tab-icon"
                        filePath={tab.filePath}
                        panel={tab.panel}
                      />
                      <input
                        ref={renameInput}
                        className="webapp-tab-rename"
                        aria-label={`Rename ${tab.label}`}
                        maxLength={SESSION_TITLE_MAX_LENGTH}
                        value={renaming.value}
                        onChange={(event) => setRenaming({
                          id: tab.id,
                          value: event.target.value.slice(0, SESSION_TITLE_MAX_LENGTH),
                        })}
                        onBlur={() => finishRename(tab)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            finishRename(tab);
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            cancelRename();
                          }
                        }}
                      />
                    </div>
                  ) : (
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
                      <span
                        className="webapp-tab-label"
                        onDoubleClick={() => beginRename(tab)}
                      >{tab.label}</span>
                      {tab.dirty && <span className="webapp-tab-dirty" aria-label="Unsaved changes">•</span>}
                    </button>
                  )}
                  {active
                    && renaming?.id !== tab.id
                    && (!isManagedSessionTab(tab) || onArchive !== undefined)
                    && (
                    <button
                      className="webapp-tab-close"
                      type="button"
                      aria-label={`Close ${tab.label}`}
                      title={tab.pending
                        ? 'Archiving session…'
                        : isManagedSessionTab(tab) ? 'Archive session' : `Close ${tab.agent}`}
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
            {(onRestore || archivedTabs.length > 0) && (
              <div className="webapp-archive-control" ref={archiveControl}>
                <button
                  className="webapp-header-action"
                  type="button"
                  aria-label="Archived sessions"
                  aria-haspopup="menu"
                  aria-expanded={archiveMenuOpen}
                  title="Archived sessions"
                  onClick={() => {
                    setArchiveMenuOpen((open) => !open);
                    setMenuOpen(false);
                    setContextMenu(null);
                  }}
                ><ArchiveIcon /></button>
                <div className="webapp-archive-menu" role="menu" hidden={!archiveMenuOpen}>
                  <p>Archived sessions</p>
                  <div className="webapp-archive-list">
                    {archivedTabs.length === 0 ? (
                      <span className="webapp-archive-empty">No archived sessions</span>
                    ) : archivedTabs.map((tab) => (
                      <div className="webapp-archive-row" key={tab.id}>
                        <button
                          className="webapp-archive-restore"
                          type="button"
                          role="menuitem"
                          title={`Restore ${tab.label}`}
                          onClick={() => {
                            setArchiveMenuOpen(false);
                            onRestore?.(tab.id);
                          }}
                        >
                          <SessionTypeIcon type={tab.agent} className="webapp-new-menu-icon" />
                          <span className="webapp-archive-label">{tab.label}</span>
                          <RestoreIcon />
                        </button>
                        <button
                          className="webapp-archive-delete"
                          type="button"
                          aria-label={`Remove ${tab.label} permanently`}
                          title={`Remove ${tab.label} permanently`}
                          onClick={() => {
                            setArchiveMenuOpen(false);
                            onDelete?.(tab.id);
                          }}
                        ><TrashIcon /></button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

      </div>
      {contextMenu && selectedContextTab && (
        <div
          ref={contextMenuElement}
          className="webapp-session-menu"
          role="menu"
          style={{ left: contextMenu.left, top: contextMenu.top }}
        >
          {selectedContextTab.renameable && onRename && (
            <button type="button" role="menuitem" onClick={() => beginRename(selectedContextTab)}>
              Rename
            </button>
          )}
          {onArchive && (
            <button type="button" role="menuitem" onClick={() => {
              setContextMenu(null);
              onArchive(selectedContextTab.id);
            }}>Archive</button>
          )}
          {onDelete && (
            <button
              className="webapp-session-menu__delete"
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                onDelete(selectedContextTab.id);
              }}
            >Remove permanently</button>
          )}
        </div>
      )}
    </header>
  );
}
