import { stageSources, getStagedSet } from './stagingStore'
import { addImage, imagesForStaged } from './imageAttachStore'
import { publishLiveTray } from './sentTrayStore'
import type { TrayGroup } from './attachTray'

// The ONE validate → dedupe → stage flow for dragged-in screenshots/files, shared by BOTH drop targets (the chat
// composer and connector dropbox) so rules are identical everywhere. Per path: extension gate (fast), dedupe on the
// ORIGINAL path against what's already staged, then main `os:attach-file` validation (magic-byte sniff + image
// thumbnail when relevant). The first problem on a path is surfaced via `onNotice`.
const ATTACH_EXT = /\.(png|jpe?g|pdf)$/i

export type AttachNotice = { ok: boolean; text: string }

export async function ingestImagePaths(
  chatId: string,
  paths: string[],
  onNotice: (n: AttachNotice) => void,
  publishGroups?: () => TrayGroup[]
): Promise<number> {
  const api = window.agentOS
  if (!api?.attachFile && !api?.attachImage) {
    if (paths.length) onNotice({ ok: false, text: 'Attachments unavailable' })
    return 0
  }
  const seen = new Set(imagesForStaged(getStagedSet(chatId)).map((m) => m.path)) // dedupe vs already-staged + within batch
  let staged = 0
  for (const path of paths) {
    if (!ATTACH_EXT.test(path)) {
      onNotice({ ok: false, text: 'Only PNG, JPG, and PDF files are supported' })
      continue
    }
    if (seen.has(path)) {
      onNotice({ ok: false, text: 'That file is already attached' })
      continue
    }
    const r = api.attachFile ? await api.attachFile(path) : { ...(await api.attachImage!(path)), kind: 'image' as const }
    if (!r?.ok || !r.id) {
      onNotice({ ok: false, text: r?.error || "Couldn't attach that file" })
      continue
    }
    seen.add(path)
    const kind = r.kind || 'image'
    addImage({ id: r.id, path: r.path || path, name: r.name || path, thumb: r.thumb || '', kind })
    stageSources(chatId, (kind === 'image' ? 'image:' : 'file:') + r.id)
    staged++
  }
  if (staged && publishGroups) publishLiveTray(chatId, publishGroups())
  return staged
}
