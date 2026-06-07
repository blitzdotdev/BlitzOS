import { app } from 'electron'
import { join } from 'path'
import { appendFileSync } from 'fs'
import { loadRecord } from './tokenStore'
import { callProviderGated, createApprovalLedger, createRateLimiter } from './provider-call.mjs'
import type { ProviderDescriptor, ProviderResult, ApprovalRequest } from './provider-call.mjs'

// #51 — Electron-side orchestration for the general /provider_call substrate. The two agent transports
// (agentSocket relay + control-server localhost) both call runProviderCall(); the renderer drives the
// write-approval card + the sensitive-read consent via the exported approve/deny/grant functions. The
// engine + ledger live in provider-call.mjs (shared with the server backend); this file is the glue:
// record resolution from the encrypted store, a broadcast to the renderer, and the audit log.

const approvals = createApprovalLedger()
const rate = createRateLimiter()
const consent = new Set<string>() // providers the human approved for SENSITIVE agent reads (message bodies, file contents)
const pending = new Map<string, { resolve: (token: string | null) => void; timer: ReturnType<typeof setTimeout> }>() // approvalRequest.id -> resolver + its expiry timer

// Settle a pending approval once (clears its expiry timer so no orphan timer fires later).
function settle(id: string, token: string | null): void {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  clearTimeout(p.timer)
  p.resolve(token)
}

let broadcast: (action: Record<string, unknown>) => void = () => {}
/** Wired in index.ts so an approval request reaches the renderer (it shows the card). */
export function setProviderBroadcast(fn: (action: Record<string, unknown>) => void): void {
  broadcast = fn
}

function audit(entry: unknown): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'provider-audit.log'), JSON.stringify(entry) + '\n')
  } catch {
    /* best-effort audit; never block a call on logging */
  }
}

/** The human approved a sensitive-read provider (renderer → IPC). allow:false revokes. */
export function grantProviderConsent(provider: string, allow: boolean): void {
  if (!provider) return
  if (allow === false) consent.delete(provider)
  else consent.add(provider)
}

/** The human approved a pending WRITE (renderer → IPC) — mints + hands back the request-bound token. */
export function resolveProviderApproval(id: string): void {
  settle(id, approvals.approve(id, Date.now()))
}
/** The human denied a pending write. */
export function denyProviderApproval(id: string): void {
  settle(id, null)
}

// Show the approval card and wait for the human (or time out at the request's own expiry).
function requestApproval(req: ApprovalRequest): Promise<string | null> {
  return new Promise((resolve) => {
    const ms = Math.max(1000, req.expiresAt - Date.now())
    const timer = setTimeout(() => settle(req.id, null), ms) // expiry → denied (timer cleared on any earlier settle)
    pending.set(req.id, { resolve, timer })
    broadcast({ type: 'provider-approval', request: req })
  })
}

/** Run a /provider_call for the agent on a given transport. Reads return data; a write surfaces the
 *  approval card and (on approval) executes — the token never leaves main. */
export async function runProviderCall(descriptor: Omit<ProviderDescriptor, 'caller'>, transport: 'relay' | 'localhost'): Promise<ProviderResult> {
  const rec = loadRecord(descriptor.provider)
  const record = rec && rec.secrets ? { secrets: rec.secrets, grantedScopes: rec.grantedScopes } : null
  return callProviderGated(
    { ...descriptor, caller: { kind: 'agent', transport } },
    { record, approvals, rate, consented: (p: string) => consent.has(p), audit, requestApproval }
  )
}
