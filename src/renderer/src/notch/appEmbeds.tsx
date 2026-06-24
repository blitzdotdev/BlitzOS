import type { IslandAppIcon, IslandAppMessagePart, IslandAppTone } from './types'

export const APP_EMBED_ICONS: IslandAppIcon[] = ['dashboard', 'report', 'table', 'checklist', 'form', 'share', 'browser', 'file']
export const APP_EMBED_TONES: IslandAppTone[] = ['sky', 'mint', 'amber', 'violet', 'lime', 'rose']

export function normalizeAppIcon(value?: string): IslandAppIcon {
  return APP_EMBED_ICONS.includes(value as IslandAppIcon) ? (value as IslandAppIcon) : 'dashboard'
}

export function normalizeAppTone(value?: string): IslandAppTone {
  return APP_EMBED_TONES.includes(value as IslandAppTone) ? (value as IslandAppTone) : 'sky'
}

export function normalizedBlitzAppUrl(value?: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return null
    if (!url.hostname.endsWith('.app.blitz.dev')) return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

export function blitzAppSubtitle(part: IslandAppMessagePart): string {
  if (part.subtitle) return part.subtitle
  try {
    return new URL(part.url).hostname
  } catch {
    return 'Generated app'
  }
}

export function normalizedBlitzAppPart(part: IslandAppMessagePart): IslandAppMessagePart | null {
  const url = normalizedBlitzAppUrl(part.url)
  if (!url) return null
  return {
    ...part,
    url,
    icon: normalizeAppIcon(part.icon),
    tone: normalizeAppTone(part.tone)
  }
}

export function AppEmbedIcon({ icon }: { icon?: string }): JSX.Element {
  switch (normalizeAppIcon(icon)) {
    case 'report':
      return (
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          <path d="M7 3h7l5 5v13H7V3Z" />
          <path d="M14 3v6h5" />
          <path d="M9 14h7" />
          <path d="M9 18h5" />
        </svg>
      )
    case 'table':
      return (
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          <path d="M4 5h16v14H4V5Z" />
          <path d="M4 11h16" />
          <path d="M10 5v14" />
          <path d="M16 5v14" />
        </svg>
      )
    case 'checklist':
      return (
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          <path d="m4 7 2 2 4-4" />
          <path d="M13 7h7" />
          <path d="m4 15 2 2 4-4" />
          <path d="M13 15h7" />
        </svg>
      )
    case 'form':
      return (
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          <path d="M5 4h14v16H5V4Z" />
          <path d="M8 8h8" />
          <path d="M8 12h8" />
          <path d="M8 16h5" />
        </svg>
      )
    case 'share':
      return (
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          <path d="M16 6 8 12l8 6" />
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
        </svg>
      )
    case 'browser':
      return (
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          <path d="M4 5h16v14H4V5Z" />
          <path d="M4 9h16" />
          <path d="M8 7h.01" />
          <path d="M11 7h.01" />
        </svg>
      )
    case 'file':
      return (
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          <path d="M7 3h7l5 5v13H7V3Z" />
          <path d="M14 3v6h5" />
        </svg>
      )
    case 'dashboard':
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          <path d="M4 13h7V4H4v9Z" />
          <path d="M13 20h7V4h-7v16Z" />
          <path d="M4 20h7v-5H4v5Z" />
        </svg>
      )
  }
}
