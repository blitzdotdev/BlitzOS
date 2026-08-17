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
import type { FolderAttachmentView } from '@blitzos/schema';
import { OutlinedLoadingRows } from './LoadingSkeleton';
import { davErrorStatus } from './files';
import {
  listedNodes,
  mergedTree,
  replaceDirectory,
  statusNode,
  type FileNode,
} from './files-tree';
import { FilesContextMenu, type FilesContextMenuState } from './FilesContextMenu';
import { FilesTreeRow } from './FilesTreeRow';
import { FinderPins, FinderToolbar, type FinderRoot } from './FinderChrome';

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
  sharedFolders: FolderAttachmentView[];
  canShare: boolean;
  onClose: () => void;
  onExpandedChange: (expanded: string[]) => void;
  onOpenFile: (filePath: string) => void;
  onOpenDriveFolder: (folderId: string) => void;
  onShareToDrive: (path: string) => void;
  onUnauthorized: () => void;
  onWidthChange: (width: number) => void;
};

type DirectoryLoadResult = 'loaded' | 'error' | 'transient-error' | 'unavailable' | 'superseded';

export const ROOT_RETRY_INTERVAL_MS = 2_500;
export const ROOT_RETRY_WINDOW_MS = 60_000;
export const FILES_POLL_INTERVAL_MS = 4_000;

function transientDavStatus(status: number | undefined): boolean {
  return status === undefined
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
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
  sharedFolders,
  canShare,
  onClose,
  onExpandedChange,
  onOpenFile,
  onOpenDriveFolder,
  onShareToDrive,
  onUnauthorized,
  onWidthChange,
}: FilesSidebarProps) {
  const [data, setData] = useState<FileNode[]>([]);
  const [root, setRoot] = useState<FinderRoot>('');
  const [rootBack, setRootBack] = useState<FinderRoot[]>([]);
  const [rootForward, setRootForward] = useState<FinderRoot[]>([]);
  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState('');
  const [rootState, setRootState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [treeHeight, setTreeHeight] = useState(1);
  const [contextMenu, setContextMenu] = useState<FilesContextMenuState | null>(null);
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

  // Reloads root plus expanded directories without loading placeholders, so
  // files created outside the sidebar (terminal, agents, editor) show up.
  const silentRefresh = useCallback(async () => {
    const requestClient = currentClient();
    if (!requestClient) return;
    const listings = new Map<string, FileStat[]>();
    let unauthorized = false;
    await Promise.all(['', ...expandedRef.current].map(async (path) => {
      try {
        listings.set(path, await requestClient.getDirectoryContents(path || '/'));
      } catch (listError) {
        if (davErrorStatus(listError) === 401) unauthorized = true;
      }
    }));
    if (unauthorized) {
      onUnauthorized();
      return;
    }
    if (!listings.has('')) return;
    setData((current) => mergedTree(current, listings));
    setRootState('ready');
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
    void silentRefresh();
  }, [refreshVersion, silentRefresh]);

  useEffect(() => {
    const refreshOnFocus = () => {
      if (!ready || !visible) return;
      if (Date.now() - lastFocusRefresh.current < 5_000) return;
      lastFocusRefresh.current = Date.now();
      void silentRefresh();
    };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [ready, silentRefresh, visible]);

  useEffect(() => {
    if (!ready || !visible) return;
    const poll = () => {
      if (document.visibilityState === 'hidden') return;
      void silentRefresh();
    };
    const timer = window.setInterval(poll, FILES_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [ready, silentRefresh, visible]);

  const renderNode = useCallback((props: NodeRendererProps<FileNode>) => (
    <FilesTreeRow
      {...props}
      loading={props.node.data.kind === 'directory' && loadingPaths.has(props.node.data.path)}
      onContextMenu={openContextMenu}
      onOpenFile={onOpenFile}
      onRetry={(path) => { void loadDirectory(path); }}
    />
  ), [loadDirectory, loadingPaths, onOpenFile, openContextMenu]);

  const goToRoot = (next: FinderRoot) => {
    if (next === root) return;
    setRootBack((stack) => [...stack, root]);
    setRootForward([]);
    setRoot(next);
    setSelectedPath('');
    if (next === 'shared') void loadDirectory('shared');
  };

  const goBack = () => {
    setRootBack((stack) => {
      const previous = stack.at(-1);
      if (previous === undefined) return stack;
      setRootForward((forward) => [...forward, root]);
      setRoot(previous);
      return stack.slice(0, -1);
    });
  };

  const goForward = () => {
    setRootForward((stack) => {
      const next = stack.at(-1);
      if (next === undefined) return stack;
      setRootBack((back) => [...back, root]);
      setRoot(next);
      return stack.slice(0, -1);
    });
  };

  const sharedNode = data.find(
    (node) => node.kind === 'directory' && node.path === 'shared',
  );
  const rootedData = root === ''
    ? data
    : sharedNode?.kind === 'directory' ? sharedNode.children ?? [] : [];
  const driveFolderFor = (directory: string): FolderAttachmentView | undefined => sharedFolders.find((folder) => {
    const guestPath = folder.guestPath ?? `shared/${folder.name}`;
    return directory === guestPath || directory.startsWith(`${guestPath}/`);
  });
  const crumbParts = selectedPath === '' ? [] : selectedPath.split('/');
  const contextDriveFolder = contextMenu === null || contextMenu.createKind !== undefined
    ? undefined
    : driveFolderFor(contextMenu.directory);
  // Publishing is offered on exact top-level workspace directories that are
  // not already synced attachments.
  const contextShareable = canShare
    && contextMenu !== null
    && contextMenu.createKind === undefined
    && contextMenu.directory !== ''
    && contextMenu.directory !== 'shared'
    && !contextMenu.directory.includes('/')
    && contextDriveFolder === undefined
    ? contextMenu.directory
    : '';

  // Path-bar crumbs jump within the tree: expand ancestors, then select.
  const jumpToPath = (path: string) => {
    const ancestors = path.split('/').slice(0, -1)
      .map((_, index, parts) => parts.slice(0, index + 1).join('/'));
    const missing = ancestors.filter((ancestor) => !expandedRef.current.includes(ancestor));
    if (missing.length > 0) onExpandedChange([...expandedRef.current, ...missing]);
    for (const ancestor of ancestors) tree.current?.open(ancestor);
    tree.current?.select(path);
    tree.current?.scrollTo(path);
    setSelectedPath(path);
  };

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
      id="webapp-files-sidebar"
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
      <FinderToolbar
        root={root}
        canBack={rootBack.length > 0}
        canForward={rootForward.length > 0}
        query={query}
        ready={ready}
        refreshing={loadingPaths.has('')}
        mobile={mobile}
        onBack={goBack}
        onForward={goForward}
        onQueryChange={setQuery}
        onRefresh={startRootRetry}
        onClose={onClose}
      />
      <div className="fnd-body">
        <FinderPins root={root} sharedCount={sharedFolders.length} onSelect={goToRoot} />
        <div className="fnd-list">
          <div className="fnd-cols" aria-hidden="true">
            <span>Name</span>
            <span>Modified</span>
            <span className="fnd-num">Size</span>
            <span>Kind</span>
          </div>
          <div
            className="files-tree"
            ref={treeBody}
            onContextMenu={(event) => openContextMenu(event, root === '' ? '' : 'shared')}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.defaultPrevented) return;
              // SAFETY: React keyboard events in this element originate from DOM Element targets.
              if ((event.target as Element).closest('button, input')) return;
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
            ) : rootedData.length === 0 ? (
              <div className="files-tree-root-state">(empty)</div>
            ) : (
              <Tree<FileNode>
                ref={tree}
                data={rootedData}
                width="100%"
                height={treeHeight}
                rowHeight={30}
                indent={12}
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
                searchTerm={query}
                searchMatch={(node, term) => node.data.kind !== 'status'
                  && node.data.name.toLowerCase().includes(term.toLowerCase())}
                onSelect={(nodes) => {
                  const selected = nodes[0]?.data;
                  setSelectedPath(selected !== undefined && selected.kind !== 'status' ? selected.path : '');
                }}
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
        </div>
      </div>
      <div className="fnd-path" aria-label="Selected path">
        <button className="fnd-crumb" type="button" onClick={() => { goToRoot(''); setSelectedPath(''); }}>
          workspace
        </button>
        {crumbParts.map((part, index) => {
          const path = crumbParts.slice(0, index + 1).join('/');
          const last = index === crumbParts.length - 1;
          return (
            <span className="fnd-crumb-pair" key={path}>
              <i aria-hidden="true">›</i>
              {last
                ? <b>{part}</b>
                : (
                  <button className="fnd-crumb" type="button" onClick={() => jumpToPath(path)}>
                    {part}
                  </button>
                )}
            </span>
          );
        })}
      </div>
      {contextMenu && (
        <FilesContextMenu
          menu={contextMenu}
          popupRef={contextPopup}
          firstActionRef={contextFirstAction}
          inputRef={createInput}
          createName={createName}
          createError={createError}
          creating={creating}
          driveFolder={contextDriveFolder}
          shareablePath={contextShareable}
          onNameChange={(name) => {
            setCreateName(name);
            setCreateError(null);
          }}
          onPickCreateKind={chooseCreateKind}
          onSubmit={(event) => { void createEntry(event); }}
          onClose={() => setContextMenu(null)}
          onOpenDriveFolder={onOpenDriveFolder}
          onShareToDrive={onShareToDrive}
        />
      )}
    </aside>
  );
}
