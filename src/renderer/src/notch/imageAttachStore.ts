import { useSyncExternalStore } from 'react'

// The metadata for dragged-in file attachments, keyed by a stable id (a hash of the absolute path, minted by main).
// Image ids live in staging as `image:<id>`; non-image file ids as `file:<id>`. THIS store resolves those staged ids
// to display data so the tray can render a thumbnail/file chip. Global on purpose (id is path-derived), ephemeral by
// design; the durable copy is the frozen tray snapshot after send. Native React external store, NO zustand.
export type ImageMeta = { id: string; path: string; name: string; thumb: string; kind?: 'image' | 'pdf' | 'file' }

let images: Record<string, ImageMeta> = {}
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const l of listeners) l()
}

export function addImage(meta: ImageMeta): void {
  if (!meta?.id || images[meta.id]) return // same id (same path) → already known, no-op
  images = { ...images, [meta.id]: meta }
  emit()
}

export function getImage(id: string): ImageMeta | undefined {
  return images[id]
}

// Resolve attachment ids in a staged set (`image:<id>` / `file:<id>`) to their metadata, in a stable order.
export function imagesForStaged(stagedSet: Set<string> | undefined): ImageMeta[] {
  if (!stagedSet?.size) return []
  const out: ImageMeta[] = []
  for (const key of stagedSet) {
    if (!key.startsWith('image:') && !key.startsWith('file:')) continue
    const meta = images[key.slice(key.indexOf(':') + 1)]
    if (meta) out.push(meta)
  }
  return out
}

// Subscribe to the (global) image map; returns a STABLE ref between changes so useSyncExternalStore never loops.
export function useImagesMap(): Record<string, ImageMeta> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => images,
    () => images
  )
}
