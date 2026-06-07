// Types for the write-approval queue (approval-queue.mjs).
import type { ApprovalRequest, ApprovalLedger } from './provider-call.mjs'

export interface ApprovalQueue {
  request(req: ApprovalRequest): Promise<string | null>
  approve(id: string): void
  deny(id: string): void
  pendingCount(): number
}
export function createApprovalQueue(opts: {
  ledger: ApprovalLedger
  broadcast: (msg: { type: string; request: ApprovalRequest }) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}): ApprovalQueue
