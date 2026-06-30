export function isAgentDoneTransition(previousStatus?: unknown, status?: unknown): boolean
export function isAgentResponseNeededTransition(previousStatus?: unknown, status?: unknown): boolean
export function isAgentErrorTransition(previousStatus?: unknown, status?: unknown): boolean
export function agentStatusNotificationKind(previousStatus?: unknown, status?: unknown): 'done' | 'response-needed' | 'error' | null
export function agentDoneNotificationCopy(agentTitle?: unknown): { title: string; body: string }
export function agentStatusNotificationCopy(kind?: unknown, agentTitle?: unknown): { title: string; body: string }
export function showAgentStatusNotification(input?: {
  Notification?: {
    isSupported(): boolean
    new (options: { title?: string; body?: string }): {
      once?(event: string, listener: (...args: unknown[]) => void): unknown
      show(): void
    }
  }
  kind?: 'done' | 'response-needed' | 'error'
  agentTitle?: unknown
  onClick?: () => void
  onError?: (error: unknown) => void
  onShow?: () => void
}): boolean
export function showAgentDoneNotification(input?: {
  Notification?: {
    isSupported(): boolean
    new (options: { title?: string; body?: string }): {
      once?(event: string, listener: (...args: unknown[]) => void): unknown
      show(): void
    }
  }
  agentTitle?: unknown
  onClick?: () => void
  onError?: (error: unknown) => void
  onShow?: () => void
}): boolean
export function _liveNotificationCountForTest(): number
