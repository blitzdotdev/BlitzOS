// OS accent theme — the live, persisted colors the user (or an agent) picks. They override the
// tokens.css defaults at runtime (CSS custom props on :root win over the stylesheet), so chrome,
// chat, focus rings, buttons and every plain widget recolor at once. Board cards that carry their
// OWN props.accent (the palette distribution) keep theirs; `accent` here is the GLOBAL one beneath.
//
// Source of truth at rest: localStorage (survives restart, applied before first paint from
// main.tsx). A set_theme tool call (widget or agent) routes through main → os:action 'set-theme'
// → applyTheme here.

const KEY = 'blitzos.theme.v1'

// The editable theme roles, each mapped to the tokens.css var it overrides + a human label and a
// plain description of what it actually colors. The picker renders this list, so it is the ONE
// source for "what am I changing" — keep it in sync with tokens.css.
export const THEME_ROLES = [
  { key: 'accent', var: '--accent', label: 'Accent', touches: 'Selection ring, focus, primary buttons, links, sliders, the active window outline' },
  { key: 'accentDeep', var: '--accent-deep', label: 'Accent pressed', touches: 'The accent darkened for hover and pressed states (auto-derived if left alone)' },
  { key: 'marker', var: '--marker', label: 'Highlighter', touches: 'Text-highlight marker and annotation pins (text stays dark on it)' },
  { key: 'positive', var: '--positive', label: 'Success', touches: 'Positive status: online dots, confirmations, done states' },
  { key: 'danger', var: '--danger', label: 'Danger', touches: 'Destructive actions, errors, the close traffic light' },
  { key: 'info', var: '--info', label: 'Info', touches: 'Informational accents and neutral status' }
] as const

export type ThemeKey = (typeof THEME_ROLES)[number]['key']
export type Theme = Partial<Record<ThemeKey, string>>

const VAR_OF: Record<string, string> = Object.fromEntries(THEME_ROLES.map((r) => [r.key, r.var]))

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim())

/** Darken a hex toward black by `amt` (0..1) — the default pressed/hover when accentDeep is unset. */
export function darken(hex: string, amt = 0.22): string {
  const n = parseInt(hex.slice(1), 16)
  const d = (c: number): string =>
    Math.round(c * (1 - amt))
      .toString(16)
      .padStart(2, '0')
  return `#${d((n >> 16) & 255)}${d((n >> 8) & 255)}${d(n & 255)}`
}

/** Apply a (partial) theme to the OS chrome. accentDeep auto-derives from accent when omitted. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement.style
  for (const r of THEME_ROLES) {
    const v = theme[r.key]
    if (isHex(v)) root.setProperty(r.var, v!.trim().toLowerCase())
  }
  // derive pressed from accent if accent given but pressed not
  if (isHex(theme.accent) && !isHex(theme.accentDeep)) root.setProperty('--accent-deep', darken(theme.accent!))
  void VAR_OF
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(theme))
  } catch {
    /* private mode / disabled storage — the theme just won't persist across restart */
  }
}

export function loadTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const t = JSON.parse(raw) as Theme
    return t && isHex(t.accent) ? t : null
  } catch {
    return null
  }
}

/** Boot: re-apply a saved theme before the app renders (call from main.tsx). */
export function bootTheme(): void {
  const t = loadTheme()
  if (t) applyTheme(t)
}
