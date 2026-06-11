// Types for the shared, transport-agnostic control core (control-core.mjs).

export type ControlAction =
  | { action: 'eval'; expression: string }
  | { action: 'read'; selector?: string }
  | { action: 'click'; selector?: string; x?: number; y?: number }
  | { action: 'type'; text: string; selector?: string; perKey?: boolean }
  | { action: 'key'; key: string }
  | { action: 'screenshot' }

/** `effect` (2B): the action's observed outcome — a typed field's value back, or url/dom-change after a
 *  click/key — so the agent can verify in-band that the act landed, without a second screenshot. */
export type ControlEffect = { value?: string; typedInto?: string; urlChanged?: boolean; domChanged?: boolean; url?: string; focused?: { tag: string; type?: string | null; name?: string | null } }
export type ControlResult = { ok: true; result?: unknown; effect?: ControlEffect } | { ok: false; error: string }

/** Minimal CDP session: the only thing the control core needs from a transport. */
export interface CdpSession {
  send(method: string, params?: unknown): Promise<any>
}

export function controlSession(session: CdpSession, action: ControlAction): Promise<ControlResult>
