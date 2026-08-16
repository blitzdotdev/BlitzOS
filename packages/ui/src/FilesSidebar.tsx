import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Tree,
  type NodeRendererProps,
  type TreeApi,
} from 'react-arborist';
import type { FileStat, WebDAVClient } from 'webdav';
import { FileTypeIcon } from './FileTypeIcon';
import { OutlinedLoadingRows } from './LoadingSkeleton';
import { davErrorStatus, fullDavPath } from './files';

type FileNode = {
  id: string;
  kind: 'file' | 'directory';
  name: string;
  path: string;
  children?: FileNode[];
} | {
  id: string;
  kind: 'status';
  path: string;
  status: 'loading' | 'empty' | 'error';
};

type FilesSidebarProps = {
  client: WebDAVClient | null;
  expanded: string[];
  getClient: () => WebDAVClient | null;
  mobile: boolean;
  open: boolean;
  ready: boolean;
  refreshVersion: number;
  visible: boolean;
  wakingStage?: string;
  width: number;
  onClose: () => void;
  onExpandedChange: (expanded: string[]) => void;
  onOpenFile: (filePath: string) => void;
  onUnauthorized: () => void;
  onWidthChange: (width: number) => void;
};

type DirectoryLoadResult = 'loaded' | 'error' | 'transient-error' | 'unavailable' | 'superseded';

export const ROOT_RETRY_INTERVAL_MS = 2_500;
export const ROOT_RETRY_WINDOW_MS = 60_000;

function transientDavStatus(status: number | undefined): boolean {
  return status === undefined
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

type FilesContextMenu = {
  x: number;
  y: number;
  directory: string;
  createKind?: 'file' | 'folder';
};

function statusNode(path: string, status: 'loading' | 'empty' | 'error'): FileNode {
  return {
    id: `//status/${status}/${path}`,
    kind: 'status',
    path,
    status,
  };
}

function listedNodes(path: string, entries: FileStat[]): FileNode[] {
  return entries
    .filter(({ basename }) => basename.length > 0)
    .sort((left, right) => (
      left.type === right.type
        ? left.basename.localeCompare(right.basename, undefined, { sensitivity: 'base' })
        : left.type === 'directory' ? -1 : 1
    ))
    .map((entry): FileNode => {
      const filePath = path ? `${path}/${entry.basename}` : entry.basename;
      const node: FileNode = {
        id: filePath,
        kind: entry.type,
        name: entry.basename,
        path: filePath,
      };
      if (entry.type === 'directory') node.children = [statusNode(filePath, 'loading')];
      return node;
    });
}

function replaceDirectory(
  nodes: FileNode[],
  path: string,
  children: FileNode[],
): FileNode[] {
  return nodes.map((node) => {
    if (node.kind !== 'directory') return node;
    if (node.path === path) return { ...node, children };
    if (!node.children) return node;
    return { ...node, children: replaceDirectory(node.children, path, children) };
  });
}

function IndentGuides({ depth }: { depth: number }) {
  if (depth === 0) return null;
  return (
    <span className="files-tree-indent-guides" aria-hidden="true">
      {Array.from({ length: depth }, (_, level) => (
        <span key={level} style={{ left: `${level * 8 + 7}px` }} />
      ))}
    </span>
  );
}

function FileTreeNode({
  node,
  style,
  loading,
  onContextMenu,
  onOpenFile,
  onRetry,
}: NodeRendererProps<FileNode> & {
  loading: boolean;
  onContextMenu: (event: ReactMouseEvent, directory: string) => void;
  onOpenFile: (path: string) => void;
  onRetry: (path: string) => void;
}) {
  const data = node.data;
  if (data.kind === 'status') {
    return (
      <div
        className="files-tree-status"
        style={style}
        onContextMenu={(event) => onContextMenu(event, data.path)}
      >
        <IndentGuides depth={node.level} />
        {data.status === 'empty' && <span>(empty)</span>}
        {data.status === 'error' && (
          <>
            <span>couldn&apos;t list · </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRetry(data.path);
              }}
            >
              retry
            </button>
          </>
        )}
      </div>
    );
  }

  const directory = data.kind === 'directory';
  return (
    <div
      className={[
        'files-tree-row',
        node.isSelected ? 'files-tree-row--selected' : '',
        data.name.startsWith('.') ? 'files-tree-row--dotfile' : '',
      ].filter(Boolean).join(' ')}
      style={style}
      title={fullDavPath(data.path)}
      onContextMenu={(event) => onContextMenu(
        event,
        directory ? data.path : data.path.split('/').slice(0, -1).join('/'),
      )}
      onClick={(event) => {
        event.stopPropagation();
        node.select();
        node.focus();
        if (directory && event.detail === 1) node.toggle();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!directory) onOpenFile(data.path);
      }}
    >
      <IndentGuides depth={node.level} />
      <span className="files-tree-chevron">
        {directory && (loading
          ? <span className="cockpit-inline-spinner files-tree-spinner" aria-label="Loading folder" />
          : (
            <span
              className={[
                'codicon',
                'codicon-chevron-right',
                node.isOpen ? 'files-tree-chevron--open' : '',
              ].filter(Boolean).join(' ')}
              aria-hidden="true"
            />
          ))}
      </span>
      {!directory && <FileTypeIcon className="files-tree-icon" filePath={data.path} />}
      <span className="files-tree-name">{data.name}</span>
    </div>
  );
}

export function FilesSidebar({
  client,
  expanded,
  getClient,
  mobile,
  open,
  ready,
  refreshVersion,
  visible,
  wakingStage,
  width,
  onClose,
  onExpandedChange,
  onOpenFile,
  onUnauthorized,
  onWidthChange,
}: FilesSidebarProps) {
  const [data, setData] = useState<FileNode[]>([]);
  const [rootState, setRootState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [treeHeight, setTreeHeight] = useState(1);
  const [contextMenu, setContextMenu] = useState<FilesContextMenu | null>(null);
  const [createName, setCreateName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const tree = useRef<TreeApi<FileNode> | undefined>(undefined);
  const treeBody = useRef<HTMLDivElement>(null);
  const contextPopup = useRef<HTMLDivElement>(null);
  const contextFirstAction = useRef<HTMLButtonElement>(null);
  const createInput = useRef<HTMLInputElement>(null);
  const expandedRef = useRef(expanded);
  const requestTokens = useRef(new Map<string, symbol>());
  const rootRetryCycle = useRef(0);
  const rootRetryTimer = useRef<number | null>(null);
  const resizeOrigin = useRef<{ x: number; width: number } | null>(null);
  const initialOpenState = useRef(Object.fromEntries(expanded.map((path) => [path, true])));
  const lastFocusRefresh = useRef(0);
  const lastRefreshVersion = useRef(refreshVersion);
  expandedRef.current = expanded;

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      // SAFETY: Browser pointer-event targets used for DOM containment are Nodes.
      if (!contextPopup.current?.contains(event.target as Node)) setContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    if (contextMenu.createKind) createInput.current?.focus();
    else contextFirstAction.current?.focus();
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    const element = treeBody.current;
    if (!element) return;
    const update = () => setTreeHeight(Math.max(1, Math.floor(element.clientHeight)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const currentClient = useCallback(
    () => client ?? getClient(),
    [client, getClient],
  );

  const loadDirectory = useCallback(async (
    path: string,
    rootFailureState: 'loading' | 'error' = 'error',
  ): Promise<DirectoryLoadResult> => {
    const requestClient = currentClient();
    if (!requestClient) return 'unavailable';
    const token = Symbol(path);
    requestTokens.current.set(path, token);
    setLoadingPaths((current) => new Set(current).add(path));
    if (!path) setRootState('loading');
    if (path) {
      setData((current) => replaceDirectory(
        current,
        path,
        [statusNode(path, 'loading')],
      ));
    }
    try {
      const result = await requestClient.getDirectoryContents(path || '/');
      if (requestTokens.current.get(path) !== token) return 'superseded';
      const children = listedNodes(path, result);
      if (path) {
        setData((current) => replaceDirectory(
          current,
          path,
          children.length > 0 ? children : [statusNode(path, 'empty')],
        ));
      } else {
        setData(children);
        setRootState('ready');
      }
      return 'loaded';
    } catch (loadError) {
      if (requestTokens.current.get(path) !== token) return 'superseded';
      if (davErrorStatus(loadError) === 401) {
        onUnauthorized();
        return 'error';
      }
      if (path) {
        setData((current) => replaceDirectory(
          current,
          path,
          [statusNode(path, 'error')],
        ));
      } else {
        setData([]);
        setRootState(rootFailureState);
      }
      return transientDavStatus(davErrorStatus(loadError)) ? 'transient-error' : 'error';
    } finally {
      if (requestTokens.current.get(path) === token) {
        requestTokens.current.delete(path);
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    }
  }, [currentClient, onUnauthorized]);

  const openContextMenu = useCallback((event: ReactMouseEvent, directory: string) => {
    if (!currentClient()) return;
    event.preventDefault();
    event.stopPropagation();
    setCreateName('');
    setCreateError(null);
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 208)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 164)),
      directory,
    });
  }, [currentClient]);

  const chooseCreateKind = (createKind: 'file' | 'folder') => {
    setCreateName('');
    setCreateError(null);
    setContextMenu((current) => current ? { ...current, createKind } : null);
  };

  const createEntry = async (event: FormEvent) => {
    event.preventDefault();
    const requestClient = currentClient();
    if (!requestClient || !contextMenu?.createKind || creating) return;
    const name = createName.trim();
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
      setCreateError('Enter a name without “/”.');
      return;
    }
    const path = contextMenu.directory ? `${contextMenu.directory}/${name}` : name;
    setCreating(true);
    setCreateError(null);
    try {
      if (contextMenu.createKind === 'folder') {
        await requestClient.createDirectory(path);
      } else if (!await requestClient.putFileContents(path, '', { overwrite: false })) {
        setCreateError('A file or folder with that name already exists.');
        return;
      }
      const directory = contextMenu.directory;
      setContextMenu(null);
      await loadDirectory(directory);
    } catch (createFailure) {
      const status = davErrorStatus(createFailure);
      if (status === 401) {
        setContextMenu(null);
        onUnauthorized();
      } else if (status === 405 || status === 409 || status === 412) {
        setCreateError('A file or folder with that name already exists.');
      } else if (status === 403) {
        setCreateError('You don’t have permission to create items here.');
      } else {
        setCreateError(`Couldn’t create ${contextMenu.createKind}. Try again.`);
      }
    } finally {
      setCreating(false);
    }
  };

  const cancelRootRetry = useCallback(() => {
    rootRetryCycle.current += 1;
    requestTokens.current.clear();
    if (rootRetryTimer.current !== null) {
      window.clearTimeout(rootRetryTimer.current);
      rootRetryTimer.current = null;
    }
  }, []);

  const startRootRetry = useCallback(() => {
    cancelRootRetry();
    if (!ready || !visible) return;
    setLoadingPaths(new Set());
    const cycle = rootRetryCycle.current;
    const startedAt = Date.now();
    setRootState('loading');

    const attempt = async () => {
      if (rootRetryCycle.current !== cycle || !ready || !visible) return;
      const result = await loadDirectory('', 'loading');
      if (rootRetryCycle.current !== cycle) return;
      if (result === 'loaded') {
        const paths = [...expandedRef.current].sort(
          (left, right) => left.split('/').length - right.split('/').length,
        );
        for (const path of paths) {
          if (rootRetryCycle.current !== cycle || !ready || !visible) return;
          await loadDirectory(path);
        }
        return;
      }
      if (result !== 'transient-error' && result !== 'unavailable') {
        if (result === 'error') setRootState('error');
        return;
      }
      const remaining = ROOT_RETRY_WINDOW_MS - (Date.now() - startedAt);
      if (remaining <= 0) {
        setRootState('error');
        return;
      }
      rootRetryTimer.current = window.setTimeout(() => {
        rootRetryTimer.current = null;
        void attempt();
      }, Math.min(ROOT_RETRY_INTERVAL_MS, remaining));
    };

    void attempt();
  }, [cancelRootRetry, loadDirectory, ready, visible]);

  useEffect(() => {
    if (!ready) {
      cancelRootRetry();
      setLoadingPaths(new Set());
      setData([]);
      setRootState('loading');
      return;
    }
    if (!visible) {
      cancelRootRetry();
      setLoadingPaths(new Set());
      return;
    }
    startRootRetry();
    return cancelRootRetry;
  }, [cancelRootRetry, client, ready, startRootRetry, visible]);

  useEffect(() => {
    if (lastRefreshVersion.current === refreshVersion) return;
    lastRefreshVersion.current = refreshVersion;
    startRootRetry();
  }, [refreshVersion, startRootRetry]);

  useEffect(() => {
    const refreshOnFocus = () => {
      if (!ready || !visible) return;
      if (Date.now() - lastFocusRefresh.current < 5_000) return;
      lastFocusRefresh.current = Date.now();
      startRootRetry();
    };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [ready, startRootRetry, visible]);

  const renderNode = useCallback((props: NodeRendererProps<FileNode>) => (
    <FileTreeNode
      {...props}
      loading={props.node.data.kind === 'directory' && loadingPaths.has(props.node.data.path)}
      onContextMenu={openContextMenu}
      onOpenFile={onOpenFile}
      onRetry={(path) => { void loadDirectory(path); }}
    />
  ), [loadDirectory, loadingPaths, onOpenFile, openContextMenu]);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mobile || event.button !== 0) return;
    resizeOrigin.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = resizeOrigin.current;
    if (!origin) return;
    onWidthChange(Math.max(200, Math.min(480, origin.width + origin.x - event.clientX)));
  };

  return (
    <aside
      id="cockpit-files-sidebar"
      className={`files-sidebar${open ? ' files-sidebar--open' : ''}`}
      style={
        // SAFETY: React accepts CSS custom properties at runtime; CSSProperties omits arbitrary `--*` keys from its static surface.
        { '--files-sidebar-width': `${width}px` } as CSSProperties
      }
      aria-label="Workspace files"
      aria-hidden={mobile && !open ? true : undefined}
      inert={mobile && !open}
    >
      {!mobile && (
        <div
          className="files-sidebar-resizer"
          role="separator"
          aria-label="Resize files sidebar"
          aria-orientation="vertical"
          onPointerDown={beginResize}
          onPointerMove={resize}
          onPointerUp={(event) => {
            resizeOrigin.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            resizeOrigin.current = null;
          }}
        />
      )}
      <header className="files-sidebar-header">
        <span>FILES</span>
        <button
          type="button"
          aria-label="Refresh files"
          title="Refresh files"
          disabled={!ready}
          onClick={startRootRetry}
        >
          {loadingPaths.has('')
            ? <span className="cockpit-inline-spinner files-tree-spinner" />
            : <span aria-hidden="true">⟳</span>}
        </button>
        <button
          type="button"
          aria-label="Close files"
          title="Close files"
          onClick={onClose}
        >⨯</button>
      </header>
      <div
        className="files-tree"
        ref={treeBody}
        onContextMenu={(event) => openContextMenu(event, '')}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.defaultPrevented) return;
          // SAFETY: React keyboard events in this element originate from DOM Element targets.
          if ((event.target as Element).closest('button')) return;
          const selected = tree.current?.selectedNodes[0] ?? tree.current?.focusedNode;
          if (!selected || selected.data.kind === 'status') return;
          event.preventDefault();
          if (selected.data.kind === 'directory') selected.toggle();
          else onOpenFile(selected.data.path);
        }}
      >
        {!ready ? (
          <div className="files-sidebar-loading">
            {wakingStage && <span className="files-sidebar-stage">{wakingStage}</span>}
            <OutlinedLoadingRows ariaLabel="Loading workspace files" count={3} />
          </div>
        ) : rootState === 'loading' ? (
          <OutlinedLoadingRows ariaLabel="Loading workspace files" count={3} />
        ) : rootState === 'error' ? (
          <div className="files-tree-root-state">
            <span>couldn&apos;t list · </span>
            <button type="button" onClick={startRootRetry}>retry</button>
          </div>
        ) : data.length === 0 ? (
          <div className="files-tree-root-state">(empty)</div>
        ) : (
          <Tree<FileNode>
            ref={tree}
            data={data}
            width="100%"
            height={treeHeight}
            rowHeight={22}
            indent={8}
            idAccessor="id"
            childrenAccessor={(node) => node.kind === 'directory' ? node.children ?? [] : null}
            initialOpenState={initialOpenState.current}
            openByDefault={false}
            selectionFollowsFocus
            disableMultiSelection
            disableDrag
            disableDrop
            disableEdit
            disableSelect={(node) => node.kind === 'status'}
            onActivate={(node) => {
              if (node.data.kind === 'file') onOpenFile(node.data.path);
            }}
            onToggle={(path) => {
              const paths = new Set(expandedRef.current);
              if (tree.current?.isOpen(path)) {
                paths.add(path);
                void (async () => {
                  if (await loadDirectory(path) !== 'loaded') return;
                  const descendants = [...paths]
                    .filter((candidate) => candidate.startsWith(`${path}/`))
                    .sort((left, right) => left.split('/').length - right.split('/').length);
                  for (const descendant of descendants) await loadDirectory(descendant);
                })();
              } else {
                paths.delete(path);
              }
              onExpandedChange([...paths]);
            }}
            aria-label="Workspace file tree"
          >
            {renderNode}
          </Tree>
        )}
      </div>
      {contextMenu && (
        <div
          className="files-context-menu"
          ref={contextPopup}
          role={contextMenu.createKind ? 'dialog' : 'menu'}
          aria-label={contextMenu.createKind
            ? `Create ${contextMenu.createKind}`
            : `Create in ${fullDavPath(contextMenu.directory)}`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.createKind ? (
            <form onSubmit={(event) => { void createEntry(event); }}>
              <div className="files-context-menu-label">
                New {contextMenu.createKind} in {fullDavPath(contextMenu.directory)}
              </div>
              <input
                ref={createInput}
                aria-label={`${contextMenu.createKind === 'file' ? 'File' : 'Folder'} name`}
                value={createName}
                disabled={creating}
                onChange={(event) => {
                  setCreateName(event.target.value);
                  setCreateError(null);
                }}
              />
              {createError && <div className="files-context-menu-error" role="alert">{createError}</div>}
              <div className="files-context-menu-actions">
                <button type="button" disabled={creating} onClick={() => setContextMenu(null)}>
                  Cancel
                </button>
                <button type="submit" disabled={creating || createName.trim().length === 0}>
                  {creating ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          ) : (
            <>
              <button
                ref={contextFirstAction}
                type="button"
                role="menuitem"
                onClick={() => chooseCreateKind('file')}
              >
                <span className="codicon codicon-new-file" aria-hidden="true" />
                New file…
              </button>
              <button type="button" role="menuitem" onClick={() => chooseCreateKind('folder')}>
                <span className="codicon codicon-new-folder" aria-hidden="true" />
                New folder…
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
