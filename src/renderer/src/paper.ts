/** Note "paper" colors (Spatial palette): a background + a legible ink. Legacy color
    names (yellow/pink/green) map onto the muted palette; the default is coral.
    Shared by the surface frame and the folder previews. */
export const NOTE_PAPER: Record<string, { bg: string; ink: string }> = {
  coral: { bg: '#ff8d61', ink: '#2a1206' },
  tan: { bg: '#a78b6a', ink: '#1f160c' },
  bone: { bg: '#d1cec2', ink: '#20211d' },
  mauve: { bg: '#493839', ink: '#ece3e1' },
  blue: { bg: '#7fa0c8', ink: '#0b1422' },
  slate: { bg: '#5b78aa', ink: '#f3f6fb' },
  ink: { bg: '#0d0d0d', ink: '#e8e8e8' },
  // legacy aliases
  yellow: { bg: '#ff8d61', ink: '#2a1206' },
  pink: { bg: '#493839', ink: '#ece3e1' },
  green: { bg: '#a78b6a', ink: '#1f160c' }
}

export function paperFor(color: unknown): { bg: string; ink: string } {
  return NOTE_PAPER[(color as string) || 'coral'] ?? NOTE_PAPER.coral
}
