export type TabStatus = 'working' | 'unread' | 'waiting' | 'idle' | null;

const FAVICON_IDLE = '/favicon.svg';
const FAVICON_UNREAD = '/favicon-unread.svg';

// On Web we intentionally only distinguish "needs your attention" (unread)
// vs "no badge" (everything else). `working` and `waiting` are silent on the
// favicon — Electron surfaces those at the OS dock level instead.
export function getFaviconHrefForStatus(status: TabStatus): string {
  return status === 'unread' ? FAVICON_UNREAD : FAVICON_IDLE;
}

/**
 * Swap the document favicon to reflect a tab status. Returns a cleanup that
 * restores the previous href.
 */
export function setFavicon(status: TabStatus): () => void {
  if (typeof document === 'undefined') return () => {};
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]');
  if (links.length === 0) return () => {};

  const previous = Array.from(links, (link) => ({ link, href: link.getAttribute('href') }));
  const target = getFaviconHrefForStatus(status);
  const resolved = new URL(target, document.baseURI).toString();
  links.forEach((link) => {
    link.setAttribute('href', resolved);
  });

  return () => {
    previous.forEach(({ link, href }) => {
      if (href === null) link.removeAttribute('href');
      else link.setAttribute('href', href);
    });
  };
}
