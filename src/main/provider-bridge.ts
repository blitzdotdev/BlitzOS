import { app } from 'electron'
import { join } from 'path'
import { appendFileSync } from 'fs'
import { loadRecord } from './tokenStore'
import { callProviderGated, createApprovalLedger, createRateLimiter } from './provider-call.mjs'
import type { ProviderDescriptor, ProviderResult } from './provider-call.mjs'
import { createApprovalQueue } from './approval-queue.mjs'

// #51 — Electron-side orchestration for the general /provider_call substrate. The two agent transports
// (agentSocket relay + control-server localhost) both call runProviderCall(); the renderer drives the
// write-approval card + the sensitive-read consent via the exported approve/deny/grant functions. The
// engine + ledger live in provider-call.mjs (shared with the server backend); this file is the glue:
// record resolution from the encrypted store, a broadcast to the renderer, and the audit log.

const approvals = createApprovalLedger()
const rate = createRateLimiter()
const consent = new Set<string>() // providers the human approved for SENSITIVE agent reads (message bodies, file contents)

let broadcast: (action: Record<string, unknown>) => void = () => {}
/** Wired in index.ts so an approval request reaches the renderer (it shows the card). */
export function setProviderBroadcast(fn: (action: Record<string, unknown>) => void): void {
  broadcast = fn
}

// The write-approval queue (concurrent pending writes tracked by id, each resolved once) — pure logic in
// approval-queue.mjs (headless-tested); here we just wire the live broadcast + the token ledger into it.
const queue = createApprovalQueue({ ledger: approvals, broadcast: (m) => broadcast(m as Record<string, unknown>) })

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
  queue.approve(id)
}
/** The human denied a pending write. */
export function denyProviderApproval(id: string): void {
  queue.deny(id)
}

/** Run a /provider_call for the agent on a given transport. Reads return data; a write surfaces the
 *  approval card and (on approval) executes — the token never leaves main. */
export async function runProviderCall(descriptor: Omit<ProviderDescriptor, 'caller'>, transport: 'relay' | 'localhost'): Promise<ProviderResult> {
  const rec = loadRecord(descriptor.provider)
  const record = rec && rec.secrets ? { secrets: rec.secrets, grantedScopes: rec.grantedScopes } : null
  return callProviderGated(
    { ...descriptor, caller: { kind: 'agent', transport } },
    { record, approvals, rate, consented: (p: string) => consent.has(p), audit, requestApproval: queue.request }
  )
}
