// Types for connection-grants.mjs (the connection permission model).
export type GrantKey =
  | 'accessibility'
  | 'screen'
  | 'automation:systemevents'
  | 'automation:chrome'
  | 'automation:safari'
  | 'allowjs:chrome'

export interface GrantDescriptor {
  grant: GrantKey
  title: string
  why: string
  button: string
  settings: string
  kind: 'settings' | 'prompt' | 'allowjs'
}

export type BrowserState = 'ok' | 'denied' | 'allowjs' | 'helper' | 'unreachable'

export const GRANTS: Record<GrantKey, GrantDescriptor>
export function permissionFromError(err: unknown, browser?: 'chrome' | 'safari'): GrantDescriptor | null
export function grantForConnection(opts: { type: string; browser?: string }): GrantDescriptor | null
export function classifyBrowserState(err: unknown): BrowserState
export function grantForBrowserState(browser: 'chrome' | 'safari', state: string): GrantDescriptor | null
export function browserBundleId(browser: 'chrome' | 'safari'): string
export function browserListTabsGate(auth: 'granted' | 'denied' | 'undetermined' | 'unknown'): BrowserState | null
