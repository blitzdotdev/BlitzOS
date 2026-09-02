import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { NewTabMenu, type SpawnSessionType } from './NewTabMenu';
import { SessionTypeIcon, type WebAppSessionType } from './SessionTypeIcon';
import type { LivePort, PreviewLink } from './preview';
import { SESSION_TITLE_MAX_LENGTH } from './storage';

export { SESSION_TITLE_MAX_LENGTH } from './storage';
export { SPAWN_SESSION_LABELS } from './NewTabMenu';
export { SessionTypeIcon } from './SessionTypeIcon';
export type { SpawnSessionType } from './NewTabMenu';
export type { WebAppSessionType } from './SessionTypeIcon';

function isManagedSessionTab(tab: WebAppTabModel): boolean {
  return tab.agent !== 'preview' && tab.agent !== 'panel';
}

export type WebAppTabModel = {
  id: string;
  label: string;
  agent: WebAppSessionType;
  pending: boolean;
  customTitle?: string;
  renameable?: boolean;
  /** Which panel a `panel` tab shows, so the strip can pick its icon. */
  panel?: 'connections';
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
  onRename?: (sessionId: string, title: string | undefined) => void;
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
  onRename,
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
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    left: number;
    top: number;
  } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const newTabControl = useRef<HTMLDivElement>(null);
  const newSessionButton = useRef<HTMLButtonElement>(null);
  const tabstrip = useRef<HTMLDivElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameFinished = useRef(false);

  useEffect(() => {
    if (!menuOpen && !contextMenu) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      // SAFETY: Browser pointer-event targets used for DOM containment are Nodes.
      const target = event.target as Node;
      if (!newTabControl.current?.contains(target)) {
        setMenuOpen(false);
        onMenuOpenChange(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
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
  }, [contextMenu, menuOpen, onMenuOpenChange]);

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
    if (!isManagedSessionTab(tab) || !tab.renameable || !onRename) return;
    event.preventDefault();
    setMenuOpen(false);
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
                      title={tab.label}
                      draggable={onTabDragStart !== undefined}
                      onDragStart={(event) => onTabDragStart?.(tab.id, event)}
                      onDragEnd={() => onTabDragEnd?.()}
                      onClick={() => onSelect(tab.id)}
                    >
                      <SessionTypeIcon
                        type={tab.agent}
                        className="webapp-tab-icon"
                        panel={tab.panel}
                      />
                      <span
                        className="webapp-tab-label"
                        onDoubleClick={() => beginRename(tab)}
                      >{tab.label}</span>
                    </button>
                  )}
                  {active && renaming?.id !== tab.id && (
                    <button
                      className="webapp-tab-close"
                      type="button"
                      aria-label={`Close ${tab.label}`}
                      title={tab.pending
                        ? 'Closing…'
                        : `Close ${tab.label}`}
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
              <NewTabMenu
                hidden={!menuOpen}
                livePorts={livePorts}
                previewLinks={previewLinks}
                onSpawn={spawnSession}
                onOpenPreview={openPreview}
                onOpenPreviewLink={openPreviewLink}
              />
            </div>}
          </>
        )}

      </div>
      {contextMenu && selectedContextTab && (
        <>
          <div className="webapp-session-backdrop" onMouseDown={() => setContextMenu(null)} />
          <div
            className="webapp-session-menu"
            role="menu"
            style={{ left: contextMenu.left, top: contextMenu.top }}
          >
            {selectedContextTab.renameable && onRename && (
              <button type="button" role="menuitem" onClick={() => beginRename(selectedContextTab)}>
                <span className="codicon codicon-edit" aria-hidden="true" />
                <span>Rename</span>
              </button>
            )}
          </div>
        </>
      )}
    </header>
  );
}
