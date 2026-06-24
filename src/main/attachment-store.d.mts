// Types for the per-message attachment snapshot store (attachment-store.mjs).

export interface AttachmentStoreDeps {
  /** Active workspace folder (snapshots live under <ws>/.blitzos/attachments/). */
  getWorkspacePath: () => string | null | undefined
  /** Workspace-watcher self-write suppression (defaults to workspace.mjs markWrite). */
  markWrite?: (p: string) => void
}

export interface AttachmentStore {
  /** All frozen snapshots for a chat: `{ "<msgKey>": TrayGroup[] }` (empty when no workspace/file). */
  listAttachments(chat: string): { attachments: Record<string, unknown> }
  /** Freeze one user message's tray (merges into the chat's file). msgKey = String(sendTs). */
  recordAttachments(chat: string, msgKey: string, groups: unknown): { ok?: boolean; error?: string }
}

export function makeAttachmentStore(deps?: AttachmentStoreDeps): AttachmentStore
