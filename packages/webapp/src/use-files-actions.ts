import {
  useEffect,
  useLayoutEffect,
  useState,
  type Dispatch,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { WebDAVClient } from 'webdav';
import { davErrorStatus, isPathAtOrBelow } from './files';
import type { FilesContextMenuState, FilesContextTarget } from './FilesContextMenu';

export type FileActionConfirmation = {
  action: 'rename' | 'delete';
  target: FilesContextTarget;
  dirtyCount: number;
};

type FilesActionsOptions = {
  currentClient: () => WebDAVClient | null;
  dirtyFilePaths: string[];
  expandedRef: RefObject<string[]>;
  requestTokens: RefObject<Map<string, symbol>>;
  contextPopup: RefObject<HTMLDivElement | null>;
  contextFirstAction: RefObject<HTMLButtonElement | null>;
  createInput: RefObject<HTMLInputElement | null>;
  loadDirectory: (path: string) => Promise<string>;
  setSelectedPath: Dispatch<SetStateAction<string>>;
  onExpandedChange: (expanded: string[]) => void;
  onPathMoved: (source: string, destination: string) => void;
  onPathDeleted: (path: string) => void;
  onUnauthorized: () => void;
};

export function useFilesActions({
  currentClient,
  dirtyFilePaths,
  expandedRef,
  requestTokens,
  contextPopup,
  contextFirstAction,
  createInput,
  loadDirectory,
  setSelectedPath,
  onExpandedChange,
  onPathMoved,
  onPathDeleted,
  onUnauthorized,
}: FilesActionsOptions) {
  const [contextMenu, setContextMenu] = useState<FilesContextMenuState | null>(null);
  const [createName, setCreateName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmation, setConfirmation] = useState<FileActionConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!contextMenu || !contextPopup.current) return;
    const popup = contextPopup.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
    const x = Math.max(viewportLeft + 8, Math.min(contextMenu.x, viewportRight - popup.width - 8));
    const y = Math.max(viewportTop + 8, Math.min(contextMenu.y, viewportBottom - popup.height - 8));
    if (x === contextMenu.x && y === contextMenu.y) return;
    setContextMenu((current) => current === contextMenu ? { ...current, x, y } : current);
  }, [contextMenu, contextPopup]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      // SAFETY: Browser pointer-event targets used for DOM containment are Nodes.
      if (confirmation === null && !contextPopup.current?.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    if (confirmation === null && (contextMenu.createKind || contextMenu.action === 'rename')) {
      createInput.current?.focus();
    } else {
      contextFirstAction.current?.focus();
    }
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [confirmation, contextFirstAction, contextMenu, contextPopup, createInput]);

  const openContextMenu = (
    event: ReactMouseEvent,
    directory: string,
    target?: FilesContextTarget,
  ): void => {
    if (!currentClient()) return;
    event.preventDefault();
    event.stopPropagation();
    setCreateName('');
    setCreateError(null);
    setActionError(null);
    const menu: FilesContextMenuState = {
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 208)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 196)),
      directory,
    };
    if (target !== undefined) menu.target = target;
    setContextMenu(menu);
  };

  const chooseCreateKind = (createKind: 'file' | 'folder'): void => {
    setCreateName('');
    setCreateError(null);
    setContextMenu((current) => current ? { ...current, createKind } : null);
  };

  const dirtyCountFor = (path: string): number => dirtyFilePaths.filter(
    (candidate) => isPathAtOrBelow(path, candidate),
  ).length;

  const chooseRename = (): void => {
    const target = contextMenu?.target;
    if (target === undefined) return;
    const dirtyCount = dirtyCountFor(target.path);
    setCreateName(target.name);
    setCreateError(null);
    setActionError(null);
    setContextMenu((current) => current?.target ? { ...current, action: 'rename' } : null);
    if (dirtyCount > 0) setConfirmation({ action: 'rename', target, dirtyCount });
  };

  const chooseDelete = (): void => {
    const target = contextMenu?.target;
    if (target === undefined) return;
    setActionError(null);
    setContextMenu((current) => current?.target ? { ...current, action: 'delete' } : null);
    setConfirmation({ action: 'delete', target, dirtyCount: dirtyCountFor(target.path) });
  };

  const createEntry = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const requestClient = currentClient();
    if (!requestClient || (!contextMenu?.createKind && contextMenu?.action !== 'rename') || creating) return;
    const name = createName.trim();
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
      setCreateError('Enter a name without “/”.');
      return;
    }
    const path = contextMenu.directory ? `${contextMenu.directory}/${name}` : name;
    setCreating(true);
    setCreateError(null);
    try {
      if (contextMenu.action === 'rename' && contextMenu.target) {
        const source = contextMenu.target.path;
        const parent = source.split('/').slice(0, -1).join('/');
        const destination = parent ? `${parent}/${name}` : name;
        if (destination === source) {
          setContextMenu(null);
          return;
        }
        await requestClient.moveFile(source, destination, { overwrite: false });
        const remap = (value: string) => value === source
          ? destination
          : value.startsWith(`${source}/`) ? `${destination}${value.slice(source.length)}` : value;
        onExpandedChange(expandedRef.current.map(remap));
        setSelectedPath((current) => remap(current));
        onPathMoved(source, destination);
      } else if (contextMenu.createKind === 'folder') {
        await requestClient.createDirectory(path);
      } else if (!await requestClient.putFileContents(path, '', { overwrite: false })) {
        setCreateError('A file or folder with that name already exists.');
        return;
      }
      const directory = contextMenu.action === 'rename' && contextMenu.target
        ? contextMenu.target.path.split('/').slice(0, -1).join('/')
        : contextMenu.directory;
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
        setCreateError(`You don’t have permission to ${contextMenu.action === 'rename' ? 'rename' : 'create'} this item.`);
      } else {
        setCreateError(contextMenu.action === 'rename'
          ? 'Couldn’t rename this item. Try again.'
          : `Couldn’t create ${contextMenu.createKind}. Try again.`);
      }
    } finally {
      setCreating(false);
    }
  };

  const deleteEntry = async (): Promise<void> => {
    const requestClient = currentClient();
    if (confirmation?.action !== 'delete' || !requestClient || busy) return;
    const { target } = confirmation;
    const parent = target.path.split('/').slice(0, -1).join('/');
    setBusy(true);
    setActionError(null);
    try {
      await requestClient.deleteFile(target.path);
      for (const path of requestTokens.current.keys()) {
        if (isPathAtOrBelow(target.path, path)) requestTokens.current.delete(path);
      }
      onExpandedChange(expandedRef.current.filter(
        (path) => !isPathAtOrBelow(target.path, path),
      ));
      setSelectedPath((current) => isPathAtOrBelow(target.path, current) ? '' : current);
      onPathDeleted(target.path);
      setContextMenu(null);
      setConfirmation(null);
      await loadDirectory(parent);
    } catch (deleteFailure) {
      const status = davErrorStatus(deleteFailure);
      if (status === 401) {
        setContextMenu(null);
        setConfirmation(null);
        onUnauthorized();
      } else if (status === 403) {
        setActionError('You don’t have permission to delete this item.');
      } else {
        setActionError('Couldn’t delete this item. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const cancelConfirmation = (): void => {
    if (busy) return;
    setConfirmation(null);
    setContextMenu(null);
    setActionError(null);
  };

  const confirmAction = (): void => {
    if (confirmation?.action === 'rename') setConfirmation(null);
    else void deleteEntry();
  };

  return {
    contextMenu,
    setContextMenu,
    createName,
    setCreateName,
    createError,
    setCreateError,
    creating,
    confirmation,
    busy,
    actionError,
    openContextMenu,
    chooseCreateKind,
    chooseRename,
    chooseDelete,
    createEntry,
    cancelConfirmation,
    confirmAction,
  };
}
