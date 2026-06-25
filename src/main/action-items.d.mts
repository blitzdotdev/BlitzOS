// Types for the shared Action-items inbox core (action-items.mjs).
export type ActionKind = 'task' | 'signin' | 'approve' | 'choose' | 'scan' | 'info'
export type ActionStatus = 'pending' | 'done' | 'dismissed'

export interface ActionItem {
  id: string
  title: string
  detail?: string
  kind: ActionKind
  agentId?: string
  choices?: string[]
  status: ActionStatus
  createdAt: number
  resolvedAt: number | null
  resolution: string | null
}

export interface ActionItemsDeps {
  getWorkspacePath: () => string | null | undefined
  /** Push a UI update to the renderer (server: SSE broadcast; Electron: webContents.send 'os:action'). */
  emit?: (ev: { type: string; item?: ActionItem; id?: string; [k: string]: unknown }) => void
  /** Wake the watching agent when the human resolves an item (perception emitSurfaceAction). */
  emitMoment?: (action: { kind: string; [k: string]: unknown }) => void
  markWrite?: (p: string) => void
}

export interface ActionItems {
  requestAction(opts: Partial<ActionItem> & { title: string }): ActionItem | null
  listActions(status?: ActionStatus): ActionItem[]
  resolveAction(id: string, resolution?: string): boolean
  clearAction(id: string): boolean
}

export function makeActionItems(deps: ActionItemsDeps): ActionItems

/** Make any inbox surface authoritative: overwrite its props.items with the current store items (listActions()).
 *  Pure; returns the same array reference when no inbox surface is present. */
export function reconcileInboxItems<S>(surfaces: S[], items: ActionItem[]): S[]
