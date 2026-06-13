// Types for the shared agent-runtime core (agent-runtime.mjs).
export function buildBootstrap(url: string, sessionId?: string, bootTask?: string | null, workspace?: string | null): string
/** Register the per-agent standing-duty provider (e.g. the onboarding interview). Re-read on every
 *  (re)launch by prepareAgentLaunch; return null for no duty. Policy-free: the text is the caller's. */
export function setBootTaskProvider(fn: ((sessionId: string) => string | null | undefined) | null): void
export function shellQuote(s: string): string
export type AgentRuntime = 'claude' | 'codex-serverless'
export function normalizeAgentRuntime(value?: string | null): AgentRuntime | string
export function buildClaudeCommand(opts: { cmd?: string; claudeSid: string; mode?: 'create' | 'resume'; bootstrapFile: string; lowThinking?: boolean }): string
export function buildCodexServerlessCommand(opts: { cmd?: string; bootstrapFile: string; lowThinking?: boolean }): string
export function buildAgentCommand(opts: { runtime?: AgentRuntime | string; cmd?: string; claudeSid?: string; mode?: 'create' | 'resume'; bootstrapFile: string; lowThinking?: boolean }): string
export function ensureClaudeSessionId(sessionsDir: string, id: string): { claudeSessionId: string; established: boolean }
export function prepareAgentLaunch(opts: { sessionsDir: string; id: string; url: string | null | undefined; cmd?: string; runtime?: AgentRuntime | string }): {
  command: string
  agentRuntime: AgentRuntime | string
  agentSessionId?: string
  claudeSessionId?: string
  established: boolean
}
/** Pre-seed claude's one-time workspace-trust ack (~/.claude.json) so an UNATTENDED interactive
 *  spawn can never stall on the trust dialog (headless -p skipped it; the live TUI does not). */
export function ensureWorkspaceTrusted(wsPath: string): void
export function writeRelayUrl(blitzDir: string, url: string | null | undefined): void
export const RELAY_URL_FILE: string
export const INTERVIEW_FAST_MODEL: string
export const INTERVIEW_FAST_SETTINGS: { model: string; effortLevel: string; env: Record<string, string> }
export const AGENT_RUNTIME_CLAUDE: 'claude'
export const AGENT_RUNTIME_CODEX_SERVERLESS: 'codex-serverless'
export const DEFAULT_AGENT_RUNTIME: 'codex-serverless'
