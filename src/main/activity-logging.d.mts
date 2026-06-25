export type ActivityEventName =
  | 'app.started'
  | 'app.focused'
  | 'app.quit'
  | 'island.opened'
  | 'island.closed'
  | 'island.view_changed'
  | 'settings.opened'
  | 'onboarding.step_viewed'
  | 'onboarding.completed'
  | 'agent.spawned'
  | 'agent.selected'
  | 'agent.status_changed'
  | 'agent.archived'
  | 'agent.restored'
  | 'agent.deleted'
  | 'agent.renamed'
  | 'chat.message_sent'
  | 'choice.shown'
  | 'choice.answered'
  | 'app_card.opened'
  | 'app_card.closed'
  | 'connector.picker_opened'
  | 'connector.connected'
  | 'connector.disconnected'
  | 'tool.called'

export const ACTIVITY_EVENT_NAMES: Set<ActivityEventName>

export function sanitizeActivityEvent(
  name: string,
  props?: Record<string, unknown>,
  opts?: { salt?: string }
): { name: ActivityEventName; props: Record<string, unknown> } | null

export function sanitizeToolActivity(
  info?: Record<string, unknown>,
  opts?: { salt?: string }
): { name: ActivityEventName; props: Record<string, unknown> } | null

export function trackActivity(name: string, props?: Record<string, unknown>): void
export function trackToolActivity(info?: Record<string, unknown>): void
export function initActivityLogging(opts?: {
  configPath?: string
  userDataDir?: string
  appVersion?: string
  branch?: string
  run?: number
  flushMs?: number
}): boolean
export function flushActivityLogging(): Promise<void>
