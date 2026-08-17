import { CheckGlyph, CloseGlyph, DownloadGlyph, KebabGlyph, LinkGlyph } from './DriveIcons';
import { DocDuoIcon } from '../files-icons';
import { DriveAvatar } from './DriveAvatar';
import { formatBytes, formatWhen, type DriveFileEntry } from './drive-model';

/** Presentational chrome shared by the Drive surface: the context menu, the
 * small confirm/name dialogs, the upload progress card, and the snackbar.
 * State and actions stay with the caller. */

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  run: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export interface UploadState {
  name: string;
  sent: number;
  total: number;
  done: boolean;
  folderName: string;
  index: number;
  count: number;
}

export function DriveMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        style={{ position: 'fixed', inset: 0, zIndex: 190, border: 0, background: 'transparent', cursor: 'default' }}
        onClick={onClose}
      />
      <div
        className="drive-menu"
        role="menu"
        style={{
          left: Math.max(8, Math.min(menu.x, window.innerWidth - 224)),
          top: Math.min(menu.y, window.innerHeight - 8 - menu.items.length * 40),
        }}
      >
        {menu.items.map((item) => (
          <button
            className={`drive-menu-item${item.danger ? ' drive-menu-item--danger' : ''}`}
            type="button"
            role="menuitem"
            key={item.label}
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.icon}<span>{item.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

export function FolderNameDialog({
  title,
  note,
  submitLabel,
  value,
  submitDisabled,
  onChange,
  onCancel,
  onSubmit,
}: {
  title: string;
  note: string;
  submitLabel: string;
  value: string;
  submitDisabled: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="drive-scrim" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="drive-dialog" role="dialog" aria-modal="true">
        <h2>{title}</h2>
        <form onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}>
          <div className="drive-dialog-body">
            <input
              className="drive-field"
              type="text"
              aria-label="Folder name"
              placeholder="Folder name"
              value={value}
              maxLength={128}
              onChange={(event) => onChange(event.currentTarget.value)}
            />
            <p className="drive-dialog-note">{note}</p>
          </div>
          <div className="drive-dialog-foot">
            <button className="drive-button" type="button" onClick={onCancel}>Cancel</button>
            <button className="drive-button drive-button--primary" type="submit" disabled={submitDisabled}>
              {submitLabel}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function DriveDeleteDialog({
  name,
  note,
  onCancel,
  onConfirm,
}: {
  name: string;
  note: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="drive-scrim" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="drive-dialog" role="dialog" aria-modal="true">
        <h2>Delete <em>“{name}”</em></h2>
        <div className="drive-dialog-body">
          <p className="drive-dialog-note">{note}</p>
        </div>
        <div className="drive-dialog-foot">
          <button className="drive-button" type="button" onClick={onCancel}>Cancel</button>
          <button className="drive-button drive-button--primary" type="button" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </section>
    </div>
  );
}

export function DriveUploaderCard({
  upload,
  onClose,
}: {
  upload: UploadState;
  onClose: () => void;
}) {
  const percent = upload.total === 0 ? 100 : Math.round((upload.sent / upload.total) * 100);
  return (
    <section className="drive-uploader" aria-label="Upload status">
      <header className="drive-uploader-head">
        <span>
          {upload.done
            ? upload.count === 1 ? 'Upload complete' : `Uploaded ${upload.count} items`
            : upload.count === 1 ? 'Uploading 1 item' : `Uploading ${upload.index} of ${upload.count}`}
        </span>
        <button
          type="button"
          aria-label={upload.done ? 'Close upload status' : 'Cancel upload'}
          onClick={onClose}
        ><CloseGlyph /></button>
      </header>
      <div className="drive-uploader-item">
        <DocDuoIcon name={upload.name} />
        <span className="drive-uploader-copy">
          <strong>{upload.name}</strong>
          {upload.done
            ? <span className="drive-uploader-state">{formatBytes(upload.total)} · in {upload.folderName}</span>
            : (
              <span className="drive-progress">
                <span className="drive-progress-fill" style={{ width: `${percent}%` }} />
              </span>
            )}
        </span>
        {upload.done
          ? <span className="drive-uploader-check"><CheckGlyph /></span>
          : <span className="drive-uploader-state">{percent}%</span>}
      </div>
    </section>
  );
}

export function DriveSnackbar({
  message,
  onDismiss,
}: {
  message: React.ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div className="drive-snackbar" role="status">
      <span>{message}</span>
      <button type="button" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

export function DriveCrumbs({
  rootLabel,
  folderName,
  path,
  attachedNote,
  onRoot,
  onFolderRoot,
  onPath,
}: {
  rootLabel: string;
  folderName: string;
  path: string[];
  attachedNote: string | null;
  onRoot: () => void;
  onFolderRoot: () => void;
  onPath: (path: string[]) => void;
}) {
  return (
    <nav className="drive-crumbs" aria-label="Breadcrumb">
      <button type="button" onClick={onRoot}>{rootLabel}</button>
      <i>›</i>
      {path.length === 0
        ? <b>{folderName}</b>
        : <button type="button" onClick={onFolderRoot}>{folderName}</button>}
      {path.map((segment, index) => (
        <span key={`${segment}-${String(index)}`} style={{ display: 'contents' }}>
          <i>›</i>
          {index === path.length - 1
            ? <b>{segment}</b>
            : (
              <button type="button" onClick={() => onPath(path.slice(0, index + 1))}>
                {segment}
              </button>
            )}
        </span>
      ))}
      {attachedNote !== null && (
        <span className="drive-crumb-attached" title={attachedNote}>
          <LinkGlyph />
        </span>
      )}
    </nav>
  );
}

export function DriveFileRow({
  entry,
  ownerName,
  ownerAvatarUrl,
  mine,
  selected,
  onToggleSelect,
  onDownload,
  onMenu,
  onContextMenu,
}: {
  entry: DriveFileEntry;
  ownerName: string;
  ownerAvatarUrl: string | null;
  mine: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onDownload: () => void;
  onMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  return (
    <div
      className={`drive-file-row${selected ? ' drive-file-row--selected' : ''}`}
      onContextMenu={onContextMenu}
    >
      <button className="drive-row-open" type="button" aria-label={entry.name} onClick={onToggleSelect} />
      <span className="drive-row-name"><DocDuoIcon name={entry.name} /><span>{entry.name}</span></span>
      <span className="drive-owner-cell">
        <DriveAvatar name={ownerName} avatarUrl={ownerAvatarUrl} me={mine} />
        <span>{mine ? 'me' : ownerName}</span>
      </span>
      <span className="drive-row-trail">{formatWhen(entry.mtime)} · {entry.editedBy}</span>
      <span className="drive-row-size">{formatBytes(entry.size)}</span>
      <span className="drive-row-actions">
        <button type="button" title="Download" aria-label={`Download ${entry.name}`} onClick={onDownload}>
          <DownloadGlyph />
        </button>
        <button type="button" title="More actions" aria-label={`More actions for ${entry.name}`} onClick={onMenu}>
          <KebabGlyph />
        </button>
      </span>
    </div>
  );
}
