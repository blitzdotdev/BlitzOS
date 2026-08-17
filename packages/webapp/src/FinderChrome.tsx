import { FolderDuoIcon, SharedFolderDuoIcon } from './files-icons';

export type FinderRoot = '' | 'shared';

/** Finder toolbar: back/forward, root title, search, refresh, mobile close. */
export function FinderToolbar({
  root,
  canBack,
  canForward,
  query,
  ready,
  refreshing,
  mobile,
  onBack,
  onForward,
  onQueryChange,
  onRefresh,
  onClose,
}: {
  root: FinderRoot;
  canBack: boolean;
  canForward: boolean;
  query: string;
  ready: boolean;
  refreshing: boolean;
  mobile: boolean;
  onBack: () => void;
  onForward: () => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fnd-tool">
      <button
        className={`fnd-tbtn${canBack ? '' : ' fnd-tbtn--off'}`}
        type="button"
        aria-label="Back"
        disabled={!canBack}
        onClick={onBack}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
      </button>
      <button
        className={`fnd-tbtn${canForward ? '' : ' fnd-tbtn--off'}`}
        type="button"
        aria-label="Forward"
        disabled={!canForward}
        onClick={onForward}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
      </button>
      <span className="fnd-title">{root === '' ? 'workspace' : 'shared'}</span>
      <span className="fnd-spacer" />
      <span className="fnd-search">
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="7" cy="7" r="4.4" /><path d="m10.4 10.4 3 3" /></svg>
        <input
          aria-label="Search files"
          placeholder="Search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </span>
      <button
        className="fnd-tbtn"
        type="button"
        aria-label="Refresh files"
        title="Refresh files"
        disabled={!ready}
        onClick={onRefresh}
      >
        {refreshing
          ? <span className="webapp-inline-spinner files-tree-spinner" />
          : (
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.2-3.2" /><path d="M13 2.6v2.6h-2.6" /></svg>
          )}
      </button>
      {mobile && (
        <button
          className="fnd-tbtn"
          type="button"
          aria-label="Close files"
          title="Close files"
          onClick={onClose}
        >⨯</button>
      )}
    </div>
  );
}

/** The Favorites rail: pinned workspace and shared roots. */
export function FinderPins({
  root,
  sharedCount,
  onSelect,
}: {
  root: FinderRoot;
  sharedCount: number;
  onSelect: (root: FinderRoot) => void;
}) {
  return (
    <aside className="fnd-side" aria-label="Pinned folders">
      <h3>Favorites</h3>
      <button
        className={`fnd-pin${root === '' ? ' fnd-pin--active' : ''}`}
        type="button"
        aria-pressed={root === ''}
        onClick={() => onSelect('')}
      >
        <FolderDuoIcon className="fnd-pin-icon" />
        workspace
      </button>
      <button
        className={`fnd-pin${root === 'shared' ? ' fnd-pin--active' : ''}`}
        type="button"
        aria-pressed={root === 'shared'}
        onClick={() => onSelect('shared')}
      >
        <SharedFolderDuoIcon className="fnd-pin-icon" />
        shared
        {sharedCount > 0 && <span className="fnd-count">{sharedCount}</span>}
      </button>
    </aside>
  );
}
