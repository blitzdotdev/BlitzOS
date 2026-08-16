import { useState } from 'react';
import type { ControlPlaneClient } from '../api';
import type { TenantMe } from '../api-adapter';
import { appliedTheme, cycleTheme, type ThemeChoice } from '../theme';
import { FilesDrive, type DriveCommand, type DrivePageRoute } from './FilesDrive';
import { SearchGlyph } from './DriveIcons';

function ThemeGlyph({ theme }: { theme: ThemeChoice }) {
  if (theme === 'dark') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2" />
      </svg>
    );
  }
  if (theme === 'light') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="7.6" />
      <path d="M12 4.4a7.6 7.6 0 0 1 0 15.2z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DriveHome({
  client,
  viewer,
  route,
  command,
  onNavigate,
  onUploadTarget,
  onOpenRail,
}: {
  client: ControlPlaneClient;
  viewer: TenantMe;
  route: DrivePageRoute;
  command: DriveCommand | null;
  onNavigate: (path: string) => void;
  onUploadTarget: (folderName: string | null) => void;
  onOpenRail: () => void;
}) {
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState<ThemeChoice>(() => appliedTheme());
  const location = route.page === 'drive' && route.scope === 'shared'
    ? 'Shared with me'
    : route.page === 'drive' ? 'My Drive' : 'folder';

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
        <button
          className="drive-icon-button"
          type="button"
          title={`Theme: ${theme}`}
          aria-label={`Theme: ${theme}`}
          onClick={() => setTheme(cycleTheme())}
        >
          <ThemeGlyph theme={theme} />
        </button>
      </header>
      <div className="drive-content">
        <FilesDrive
          client={client}
          viewer={viewer}
          route={route}
          query={query}
          command={command}
          onNavigate={(path) => {
            setQuery('');
            onNavigate(path);
          }}
          onUploadTarget={onUploadTarget}
        />
      </div>
    </>
  );
}
