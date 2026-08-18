import { useState } from 'react';
import type { ControlPlaneClient } from '../api';
import type { TenantMe } from '../api-adapter';
import { FilesDrive, type DrivePageRoute } from './FilesDrive';
import { SearchGlyph } from './DriveIcons';

export function DriveHome({
  client,
  viewer,
  route,
  onNavigate,
  onOpenRail,
}: {
  client: ControlPlaneClient;
  viewer: TenantMe;
  route: DrivePageRoute;
  onNavigate: (path: string) => void;
  onOpenRail: () => void;
}) {
  const [query, setQuery] = useState('');
  const location = route.page === 'drive' ? 'Drive' : 'folder';

  return (
    <>
      <header className="drive-topbar">
        <button
          className="drive-icon-button drive-topbar-menu"
          type="button"
          aria-label="Open navigation"
          onClick={onOpenRail}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
            <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />
          </svg>
        </button>
        <div className="drive-search">
          <SearchGlyph />
          <input
            type="search"
            placeholder={`Search in ${location}`}
            aria-label={`Search in ${location}`}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
      </header>
      <div className="drive-content">
        <FilesDrive
          client={client}
          viewer={viewer}
          route={route}
          query={query}
          onNavigate={(path) => {
            setQuery('');
            onNavigate(path);
          }}
        />
      </div>
    </>
  );
}
