import { useEffect, useRef, useState } from 'react';
import { CodexIcon, FileIcon, ShellIcon } from './CockpitIcons';
import { FileTypeIcon } from './FileTypeIcon';
import type { LivePort } from './preview';
import type { TerminalAgent } from './protocol';

export type CockpitSessionType = TerminalAgent | 'terminal' | 'chat' | 'file' | 'preview';
export type SpawnSessionType = 'claude' | 'codex' | 'terminal' | 'chat';

export const SPAWN_SESSION_LABELS: Record<SpawnSessionType, string> = {
  chat: 'Chat',
  claude: 'Claude',
  codex: 'Codex',
  terminal: 'Terminal',
};

const SPAWN_SESSION_TYPES: SpawnSessionType[] = [
  'chat',
  'claude',
  'codex',
  'terminal',
];

export type CockpitTabModel = {
  id: string;
  label: string;
  agent: CockpitSessionType;
  pending: boolean;
  customTitle?: string;
  renameable?: boolean;
  dirty?: boolean;
  filePath?: string;
  title?: string;
};

type CockpitHeaderProps = {
  tabs: CockpitTabModel[];
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
  onOpenPreview?: (port: number) => boolean;
  onMenuOpenChange?: (open: boolean) => void;
};

export function SessionTypeIcon({
  type,
  className,
  filePath,
}: {
  type: CockpitSessionType | 'terminal';
  className: string;
  filePath?: string;
}) {
  if (type === 'chat') return <span className={`${className} mi-chat`} aria-hidden="true" />;
  if (type === 'claude') return <span className={`${className} mi-claude`} aria-hidden="true" />;
  if (type === 'opencode') return <span className={`${className} mi-opencode`} aria-hidden="true" />;
  if (type === 'pi') return <span className={`${className} mi-pi`} aria-hidden="true" />;
  if (type === 'kimi') return <span className={`${className} mi-kimi`} aria-hidden="true" />;
  if (type === 'prime') return <span className={`${className} mi-prime`} aria-hidden="true" />;
  if (type === 'terminal') return <ShellIcon className={className} />;
  if (type === 'preview') return <span className={`${className} mi-preview`} aria-hidden="true" />;
  if (type === 'file') {
    return filePath
      ? <FileTypeIcon className={className} filePath={filePath} />
      : <FileIcon className={className} />;
  }
  return <CodexIcon className={className} />;
}

export function CockpitHeader({
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
  onOpenPreview = () => false,
  onMenuOpenChange = () => undefined,
}: CockpitHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const newTabControl = useRef<HTMLDivElement>(null);
  const newSessionButton = useRef<HTMLButtonElement>(null);
  const tabstrip = useRef<HTMLDivElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameFinished = useRef(false);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
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
    const active = [...(tabstrip.current?.querySelectorAll<HTMLElement>('.cockpit-tab-cell') ?? [])]
      .find((cell) => cell.dataset.sessionId === activeSessionId);
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeSessionId, tabs.length]);

  useEffect(() => {
    renameInput.current?.focus();
    renameInput.current?.select();
  }, [renaming?.id]);

  const beginRename = (tab: CockpitTabModel) => {
    if (!tab.renameable || !onRename) return;
    renameFinished.current = false;
    setRenaming({ id: tab.id, value: tab.customTitle ?? tab.label });
  };
  const finishRename = (tab: CockpitTabModel) => {
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
  const openPreview = (port: number) => {
    setMenuOpen(false);
    onMenuOpenChange(false);
    onOpenPreview(port);
    newSessionButton.current?.focus();
  };

  return (
    <header className="cockpit-header">
      <div className="cockpit-header-main">
        {mobile && (
          <button
            className="cockpit-drawer-open"
            type="button"
            aria-label="Open workspace navigation"
            aria-controls="cockpit-navigation-drawer"
            aria-expanded={drawerOpen}
            onClick={onOpenDrawer}
          ><span aria-hidden="true">☰</span></button>
        )}
        {!paneStrips && (
          <div className="cockpit-tabstrip" ref={tabstrip} role="tablist" aria-label="Workspace sessions">
            {tabs.map((tab) => {
              const active = tab.id === activeSessionId;
              return (
                <div
                  className={`cockpit-tab-cell${active ? ' cockpit-tab-cell--active' : ''}`}
                  data-session-id={tab.id}
                  key={tab.id}
                >
                  {renaming?.id === tab.id ? (
                    <div className="cockpit-tab-select cockpit-tab-select--editing">
                      <SessionTypeIcon
                        type={tab.agent}
                        className="cockpit-tab-icon"
                        filePath={tab.filePath}
                      />
                      <input
                        ref={renameInput}
                        className="cockpit-tab-rename"
                        aria-label={`Rename ${tab.label}`}
                        value={renaming.value}
                        onChange={(event) => setRenaming({ id: tab.id, value: event.target.value })}
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
                      className="cockpit-tab-select"
                      type="button"
                      role="tab"
                      aria-selected={active}
                      title={tab.title ?? (tab.renameable ? 'Double-click the label to rename' : undefined)}
                      onClick={() => onSelect(tab.id)}
                    >
                      <SessionTypeIcon
                        type={tab.agent}
                        className="cockpit-tab-icon"
                        filePath={tab.filePath}
                      />
                      <span
                        className="cockpit-tab-label"
                        onDoubleClick={() => beginRename(tab)}
                      >{tab.label}</span>
                      {tab.dirty && <span className="cockpit-tab-dirty" aria-label="Unsaved changes">•</span>}
                    </button>
                  )}
                  {active && renaming?.id !== tab.id && (
                    <button
                      className="cockpit-tab-close"
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
              );
            })}

            <div
              className="cockpit-new-tab-control"
              ref={newTabControl}
              role="group"
              aria-label="New session"
            >
              <button
                ref={newSessionButton}
                className="cockpit-new-tab-spawn"
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
                {!mobile && <span>New session</span>}
              </button>
              <div className="cockpit-agent-menu" role="menu" hidden={!menuOpen}>
                {SPAWN_SESSION_TYPES.map((agent) => (
                  <button type="button" role="menuitem" key={agent} onClick={() => spawnSession(agent)}>
                    <SessionTypeIcon type={agent} className="cockpit-new-menu-icon" />
                    {SPAWN_SESSION_LABELS[agent]}
                  </button>
                ))}
                {livePorts.length > 0 && (
                  <>
                    <div className="cockpit-agent-menu__separator" role="separator" />
                    {livePorts.map((entry) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={entry.port}
                        onClick={() => openPreview(entry.port)}
                      >
                        <SessionTypeIcon type="preview" className="cockpit-new-menu-icon" />
                        <span>:{entry.port}</span>
                        <span className="cockpit-agent-menu__process">{entry.process}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

      </div>
    </header>
  );
}
