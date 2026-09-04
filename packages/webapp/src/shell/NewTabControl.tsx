import { useEffect, useState } from 'react';
import { NewTabMenu, type SpawnSessionType } from '../NewTabMenu';
import type { LivePort, PreviewLink } from '../preview';
import { PlusGlyph } from './StripIcons';

export type NewTabControlProps = {
  livePorts: LivePort[];
  previewLinks: PreviewLink[];
  onSpawnSession: (type: SpawnSessionType) => void;
  onOpenPreview: (port: number) => void;
  onOpenPreviewLink: (url: string, title: string) => void;
  /**
   * `'bar'` is the rail's own pinned action, full width above the list.
   * `'icon'` is the same menu behind a `+` glyph, for the Terminals section
   * header the vendored rail draws (plans/LODY-SESSIONS.md §8).
   */
  variant: 'bar' | 'icon';
};

/**
 * The New tab menu, and the two shapes the rail asks it to take.
 *
 * One component because the menu is one product control: Claude Code TUI, Codex
 * TUI, terminal, plus whatever preview ports and links the box is advertising.
 * Since the native tab strip was deleted (plans/LODY-TERMINAL-TABS.md §4.6) this
 * is the ONLY spawn affordance the shell owns, in both of its shapes.
 */
export function NewTabControl({
  livePorts,
  previewLinks,
  onSpawnSession,
  onOpenPreview,
  onOpenPreviewLink,
  variant,
}: NewTabControlProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

  return (
    <div className={variant === 'bar' ? 'shell-newbar' : 'shell-newbar shell-newbar--icon'}>
      <button
        className={variant === 'bar' ? 'shell-new' : 'shell-ib'}
        type="button"
        aria-label="New tab"
        title={variant === 'bar' ? undefined : 'New tab'}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span className="shell-g"><PlusGlyph className="shell-new__plus" /></span>
        {variant === 'bar' && 'New tab'}
      </button>
      {menuOpen && (
        <button
          className="webapp-org-backdrop"
          type="button"
          aria-label="Close new tab menu"
          tabIndex={-1}
          onMouseDown={() => setMenuOpen(false)}
        />
      )}
      {menuOpen && (
        <NewTabMenu
          className="shell-newmenu"
          livePorts={livePorts}
          previewLinks={previewLinks}
          onSpawn={(agent) => {
            setMenuOpen(false);
            onSpawnSession(agent);
          }}
          onOpenPreview={(port) => {
            setMenuOpen(false);
            onOpenPreview(port);
          }}
          onOpenPreviewLink={(url, title) => {
            setMenuOpen(false);
            onOpenPreviewLink(url, title);
          }}
        />
      )}
    </div>
  );
}
