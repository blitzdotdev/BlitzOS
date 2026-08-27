import type { MouseEvent as ReactMouseEvent } from 'react';
import type { NodeRendererProps } from 'react-arborist';
import { fullDavPath } from './files';
import { formatBytes } from './files/drive-model';
import { finderDate, type FileNode } from './files-tree';
import { DocDuoIcon, FolderDuoIcon } from './files-icons';

/** One Finder row: disclosure chevron, duotone icon, name, then the
 * Modified / Size / Kind metadata columns. */
export function FilesTreeRow({
  node,
  style,
  loading,
  onContextMenu,
  onOpenFile,
  onRetry,
}: NodeRendererProps<FileNode> & {
  loading: boolean;
  onContextMenu: (
    event: ReactMouseEvent,
    directory: string,
    target?: { path: string; name: string; kind: 'file' | 'directory' },
  ) => void;
  onOpenFile: (path: string) => void;
  onRetry: (path: string) => void;
}) {
  const data = node.data;
  // react-arborist indents by padding the whole row; Finder columns must stay
  // aligned, so the indent moves inside the name cell.
  const { paddingLeft, ...rowStyle } = style;
  if (data.kind === 'status') {
    return (
      <div
        className="files-tree-status"
        style={rowStyle}
        onContextMenu={(event) => onContextMenu(event, data.path)}
      >
        <span style={{ display: 'inline-block', width: paddingLeft ?? 0 }} />
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
        'fnd-row',
        node.isSelected ? 'files-tree-row--selected' : '',
        data.name.startsWith('.') ? 'files-tree-row--dotfile' : '',
      ].filter(Boolean).join(' ')}
      style={rowStyle}
      title={fullDavPath(data.path)}
      onContextMenu={(event) => onContextMenu(
        event,
        directory ? data.path : data.path.split('/').slice(0, -1).join('/'),
        { path: data.path, name: data.name, kind: data.kind },
      )}
      onClick={(event) => {
        event.stopPropagation();
        node.select();
        node.focus();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (directory) node.toggle();
        else onOpenFile(data.path);
      }}
    >
      <span className="fnd-name" style={{ paddingLeft: paddingLeft ?? 0 }}>
        <button
          className={`fnd-chevron${node.isOpen ? ' fnd-chevron--open' : ''}${directory ? '' : ' fnd-chevron--hidden'}`}
          type="button"
          tabIndex={-1}
          aria-hidden={!directory}
          aria-label={directory ? `${node.isOpen ? 'Collapse' : 'Expand'} ${data.name}` : undefined}
          onClick={(event) => {
            event.stopPropagation();
            if (directory) node.toggle();
          }}
        >
          {loading
            ? <span className="webapp-inline-spinner files-tree-spinner" aria-label="Loading folder" />
            : (
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="m4.2 2.4 3.6 3.6-3.6 3.6" />
              </svg>
            )}
        </button>
        {directory
          ? <FolderDuoIcon className="fnd-icon" open={node.isOpen} />
          : <DocDuoIcon className="fnd-icon" name={data.name} />}
        <span className="fnd-label">{data.name}</span>
      </span>
      <span className="fnd-meta fnd-date">{finderDate(data.mtime)}</span>
      <span className="fnd-meta fnd-num">
        {data.kind === 'file' && data.size !== null ? formatBytes(data.size) : '--'}
      </span>
      <span className="fnd-meta fnd-kind">{data.fileKind}</span>
    </div>
  );
}
