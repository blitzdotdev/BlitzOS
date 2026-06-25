export const AGENT_TITLE_MAX: number
export const AGENT_TITLE_TIMEOUT_MS: number
export const AGENT_TITLE_SCHEMA: Record<string, unknown>

export function sanitizeAgentTitle(value: unknown, max?: number): string
export function buildAgentTitlePrompt(firstMessage: unknown): string
export function parseClaudeTitleOutput(stdout: unknown): string
export function runClaudeTitle(opts?: {
  prompt?: string
  schema?: Record<string, unknown>
  cwd?: string
  timeoutMs?: number
}): Promise<string>
export function generateAgentTitle(opts?: {
  text?: unknown
  agentId?: unknown
  workspacePath?: string
  timeoutMs?: number
  runClaude?: (opts: { prompt: string; schema: Record<string, unknown>; cwd?: string; timeoutMs: number }) => Promise<unknown> | unknown
  logger?: { warn?: (...args: unknown[]) => void }
}): Promise<string | null>
