// Types for the shared, transport-agnostic control core (control-core.mjs).

export type ControlAction =
  | { action: 'eval'; expression: string }
  | { action: 'read'; selector?: string }
  | { action: 'click'; selector?: string; x?: number; y?: number }
  | { action: 'type'; text: string; selector?: string; perKey?: boolean }
  | { action: 'key'; key: string }
  | { action: 'screenshot' }

export type ControlResult = { ok: true; result?: unknown } | { ok: false; error: string }

/** Minimal CDP session: the only thing the control core needs from a transport. */
export interface CdpSession {
  send(method: string, params?: unknown): Promise<any>
}

export function controlSession(session: CdpSession, action: ControlAction): Promise<ControlResult>
