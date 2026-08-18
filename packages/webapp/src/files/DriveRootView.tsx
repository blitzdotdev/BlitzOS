import { useState } from 'react';
import type { FolderView } from '../file-library-api';
import type { DriveScope } from '../sessions-page-state';
import { FolderPlusGlyph, PlusGlyph, UploadGlyph } from './DriveIcons';

/** The Drive root: owned folders with a New menu, and — since Drive is the
 * single rail destination — the folders shared with the viewer below them. */
export function DriveRootView({
  scope,
  scopeTitle,
  query,
  visible,
  sharedVisible,
  renderTile,
  onNewFolder,
  onUploadFolder,
}: {
  scope: DriveScope;
  scopeTitle: string;
  query: string;
  visible: FolderView[];
  sharedVisible: FolderView[];
  renderTile: (folder: FolderView) => React.ReactNode;
  onNewFolder: () => void;
  onUploadFolder: () => void;
}) {
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  return (
    <div>
      <div className="drive-head-row">
        <h1 className="drive-title">{scopeTitle}</h1>
        {scope === 'mine' && (
          <div className="drive-new-wrap">
            <button
              className="drive-new-button"
              type="button"
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
              onClick={() => setNewMenuOpen((open) => !open)}
            >
              <PlusGlyph /><span>New</span>
            </button>
            {newMenuOpen && (
              <>
                <button
                  type="button"
                  aria-label="Close menu"
                  className="drive-new-scrim"
                  onClick={() => setNewMenuOpen(false)}
                />
                <div className="drive-menu drive-new-menu" role="menu">
                  <button
                    className="drive-menu-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNewMenuOpen(false);
                      onNewFolder();
                    }}
                  >
                    <FolderPlusGlyph /><span>New folder</span>
                  </button>
                  <button
                    className="drive-menu-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNewMenuOpen(false);
                      onUploadFolder();
                    }}
                  >
                    <UploadGlyph /><span>Upload folder</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {visible.length === 0 ? (
        <div className="drive-empty">
          {query.trim() !== ''
            ? `No folders in ${scopeTitle} match “${query.trim()}”`
            : scope === 'shared'
              ? 'Nothing is shared with you yet'
              : 'Nothing here yet — make a folder with New'}
        </div>
      ) : (
        <section className="drive-section">
          <h2 className="drive-section-title">Folders</h2>
          <div className="drive-tiles">{visible.map(renderTile)}</div>
        </section>
      )}
      {scope === 'mine' && sharedVisible.length > 0 && (
        <section className="drive-section">
          <h2 className="drive-section-title">Shared with me</h2>
          <div className="drive-tiles">{sharedVisible.map(renderTile)}</div>
        </section>
      )}
    </div>
  );
}
