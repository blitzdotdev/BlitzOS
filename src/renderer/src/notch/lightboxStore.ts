import { useSyncExternalStore } from 'react'

// The screenshot LIGHTBOX (click a thumbnail → expand). A module store so any AttachTray instance (the dropbox,
// the composer strip, or a frozen in-chat snapshot) can open the viewer without prop-threading through AttachPanel.
// IslandPanel renders the single overlay subscribed to this. Native React external store, NO zustand.
export type LightboxImage = { path: string; name: string; thumb: string }
export type LightboxState = { image: LightboxImage; images: LightboxImage[]; index: number }

let current: LightboxState | null = null
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const l of listeners) l()
}

const sameImage = (a: LightboxImage, b: LightboxImage): boolean => a.path === b.path

export function openLightbox(img: LightboxImage, images: LightboxImage[] = [img]): void {
  const carousel = images.length ? images : [img]
  const index = Math.max(0, carousel.findIndex((m) => sameImage(m, img)))
  current = { image: carousel[index] || img, images: carousel, index }
  emit()
}

export function stepLightbox(delta: -1 | 1): void {
  if (!current || current.images.length < 2) return
  const nextIndex = current.index + delta
  if (nextIndex < 0 || nextIndex >= current.images.length) return
  current = { ...current, image: current.images[nextIndex], index: nextIndex }
  emit()
}

export function closeLightbox(): void {
  if (!current) return
  current = null
  emit()
}

export function useLightbox(): LightboxState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
    () => current
  )
}
