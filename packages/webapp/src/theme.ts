export type ThemeChoice = 'dark' | 'light' | 'system';

/* Device-local ephemera by design (IDENTITY.md): theme is a per-device
 * preference, like rail collapse — it never moves server-side. */
const THEME_KEY = 'blitz-theme';

export function appliedTheme(): ThemeChoice {
  const value = document.documentElement.getAttribute('data-theme');
  return value === 'dark' || value === 'light' ? value : 'system';
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

/** The mockup's cycle: system → dark → light → system. */
export function cycleTheme(): ThemeChoice {
  const current = appliedTheme();
  const next: ThemeChoice = current === 'system' ? 'dark' : current === 'dark' ? 'light' : 'system';
  apply(next);
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {
    // Sandboxed storage: the choice still applies for this page.
  }
  return next;
}
