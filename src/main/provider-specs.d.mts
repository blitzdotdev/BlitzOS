// Types for the provider capability core (provider-specs.mjs).
export interface ProviderRoute {
  name: string
  method: string
  path: string
  query?: Record<string, string>
  resource?: boolean
  scopeReq?: string
  risk?: 'write' | 'destructive'
  normalize?: (json: unknown) => unknown
}
export interface ProviderSpec {
  hosts: string[]
  apiBase: string | ((record: unknown) => string)
  auth: (record: unknown) => Record<string, string>
  headers: string[]
  reads: string[]
  sensitive: string[]
  routes: ProviderRoute[]
}
export const PROVIDER_SPECS: Record<string, ProviderSpec>
export function validatePath(path: string): string | null
export function matchRoute(spec: ProviderSpec, method: string, path: string): { kind: string; route?: ProviderRoute; sensitive?: boolean } | null
export function buildUrl(spec: ProviderSpec, path: string, query: unknown, record: unknown): { url: string; host: string } | { error: string; code: number }
export function redact(v: unknown): unknown
export function safeHeaders(spec: ProviderSpec, headers: unknown): Record<string, string>
export function resourceRoute(provider: string, resourceName: string): ProviderRoute | null
export function listResourceNames(): string[]
export function capturedScopes(secrets: unknown): string[]
