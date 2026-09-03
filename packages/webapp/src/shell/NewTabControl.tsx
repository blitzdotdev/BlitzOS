import { useEffect, useState } from 'react';
import { NewTabMenu, type SpawnSessionType } from '../NewTabMenu';
import { SessionTypeIcon } from '../SessionTypeIcon';
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
   * `'footer'` is the same menu behind a terminal glyph, in the footer of the
   * vendored rail, to the left of their Archive entry
   * (`vendor/lody/BLITZ-PATCHES.md` seam patch 18). The menu opens upward
   * there, because below the footer is the end of the rail.
   */
  variant: 'bar' | 'footer';
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
    <div className={variant === 'bar' ? 'shell-newbar' : 'shell-newbar shell-newbar--footer'}>
      <button
        className={variant === 'bar' ? 'shell-new' : 'shell-ib'}
        type="button"
        aria-label="New tab"
        title={variant === 'bar' ? undefined : 'New tab'}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {variant === 'bar' ? (
          <>
            <span className="shell-g"><PlusGlyph className="shell-new__plus" /></span>
            New tab
          </>
        ) : (
          // The terminal glyph every tab strip and rail row draws a terminal
          // with, so the footer's trigger reads as "a terminal" and not as a
          // second "+" beside their own.
          <SessionTypeIcon type="terminal" className="shell-ib__glyph" />
        )}
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
