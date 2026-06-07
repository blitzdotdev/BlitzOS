// Types for the provider-call engine (provider-call.mjs).
export interface ProviderDescriptor {
  provider: string
  method?: string
  path: string
  query?: Record<string, unknown>
  body?: unknown
  approvalToken?: string
  caller?: { kind?: 'agent' | 'widget'; transport?: 'relay' | 'localhost' | 'server'; surfaceId?: string }
}
export interface ApprovalRequest {
  id: string
  provider: string
  method: string
  path: string
  risk: string
  route?: string
  summary: string
  expiresAt: number
}
export interface ProviderResult {
  ok: boolean
  status: number
  data?: unknown
  code?: string
  error?: string
  requiresApproval?: boolean
  approvalRequest?: ApprovalRequest
}
export interface ApprovalLedger {
  mint(req: { provider: string; method: string; path: string; risk: string; route?: string; reqHash: string; summary: string; now: number }): ApprovalRequest
  approve(id: string, now: number): string | null
  verifyConsume(token: string, reqHash: string, now: number): boolean
  snapshot(): { pending: unknown[]; tokens: unknown[] }
}
export interface RateLimiter {
  take(key: string, kind: string, now: number): boolean
}
export interface ProviderCtx {
  record?: { secrets: Record<string, unknown>; grantedScopes?: string[] } | null
  approvals?: ApprovalLedger
  rate?: RateLimiter
  consented?: (provider: string) => boolean
  audit?: (entry: unknown) => void
  fetchImpl?: typeof fetch
  now?: () => number
  requestApproval?: (req: ApprovalRequest) => Promise<string | null>
}
export function callProvider(descriptor: ProviderDescriptor, ctx?: ProviderCtx): Promise<ProviderResult>
export function callProviderGated(descriptor: ProviderDescriptor, ctx?: ProviderCtx): Promise<ProviderResult>
export function createApprovalLedger(opts?: { ttlMs?: number }): ApprovalLedger
export function createRateLimiter(opts?: { readPerMin?: number; writePerMin?: number }): RateLimiter
