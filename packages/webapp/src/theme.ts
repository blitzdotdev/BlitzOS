export type ThemeChoice = 'dark' | 'light' | 'system';

/* Device-local ephemera by design (IDENTITY.md): theme is a per-device
 * preference, like rail collapse — it never moves server-side. */
const THEME_KEY = 'blitz-theme';

export function appliedTheme(): ThemeChoice {
  const value = document.documentElement.getAttribute('data-theme');
  return value === 'dark' || value === 'light' ? value : 'system';
}

/**
 * The theme the page is actually PAINTED in, with `system` resolved.
 *
 * `appliedTheme()` answers what the member chose; this answers what
 * `tokens.css` is currently serving. The two differ under `system`, where the
 * light palette comes from `@media (prefers-color-scheme: light)` and there is
 * no attribute to read. Anything that has to agree with the page's colours —
 * the Lody surface's own theme, above all — must ask this one.
 */
export function resolvedTheme(): 'dark' | 'light' {
  const choice = appliedTheme();
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Calls `listener` whenever `resolvedTheme()` changes.
 *
 * Two sources, because there are two ways the page can repaint: the topbar
 * toggle writes `data-theme` on the html element, and under `system` the OS
 * flips `prefers-color-scheme` with no DOM change at all. A consumer that
 * watched only the attribute would stay dark on a light laptop at sunrise.
 */
export function subscribeTheme(listener: (theme: 'dark' | 'light') => void): () => void {
  let last = resolvedTheme();
  const notify = (): void => {
    const next = resolvedTheme();
    if (next === last) return;
    last = next;
    listener(next);
  };
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
  const query = window.matchMedia('(prefers-color-scheme: light)');
  query.addEventListener('change', notify);
  return () => {
    observer.disconnect();
    query.removeEventListener('change', notify);
  };
}

function apply(choice: ThemeChoice): void {
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
}

export function initTheme(): void {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') apply(saved);
  } catch {
    // Sandboxed storage: fall back to the system scheme.
  }
}

export function chooseTheme(choice: ThemeChoice): ThemeChoice {
  apply(choice);
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Sandboxed storage: the choice still applies for this page.
  }
  return choice;
}

