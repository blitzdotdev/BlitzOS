// Types for the shared agent-runtime core (agent-runtime.mjs).
export function buildBootstrap(url: string, sessionId?: string, bootTask?: string | null, workspace?: string | null, userInstructions?: string | null, resume?: boolean): string
/** Register the per-agent standing-duty provider (e.g. the onboarding interview). Re-read on every
 *  (re)launch by prepareAgentLaunch; return null for no duty. Policy-free: the text is the caller's. */
export function setBootTaskProvider(fn: ((sessionId: string) => string | null | undefined) | null): void
/** Register the user's standing custom-instructions provider — text injected into every session's first
 *  message (both backends) wrapped in <user-instructions> tags. Re-read on every (re)launch by
 *  prepareAgentLaunch; return null/empty for none. Policy-free: the text is the user's. */
export function setUserInstructionsProvider(fn: ((sessionId: string) => string | null | undefined) | null): void
/** Write the `blitz` workflow runner shim (-> blitzscript/run.mjs) + copy the orchestrator duty doc into a workspace's
 *  `.blitzos` dir. Idempotent; called per (re)launch by prepareAgentLaunch so the runner is always current. */
export function writeBlitzShim(blitzDir: string): void
/** The standing duty STRING for an agent with the orchestrators toggle ON (author + run workflows, Claude Code
 *  workflow style). Teaches the injected-globals interface (`export const meta` + `agent()`/`parallel`/`pipeline`/
 *  `phase`/`log`, NO imports) and the `blitz` check/run commands; it carries no import path. Policy-free. */
export function orchestratorBootTask(): string
export function shellQuote(s: string): string
export type AgentRuntime = 'claude' | 'codex-serverless'
/** A Claude Code `--settings` hooks object (a generic seam buildClaudeCommand merges into --settings). */
export interface HookSettings {
  hooks: { [event: string]: Array<{ hooks: Array<{ type: string; command: string }> }> }
}
export function normalizeAgentRuntime(value?: string | null): AgentRuntime | string
export function buildClaudeCommand(opts: { cmd?: string; claudeSid: string; mode?: 'create' | 'resume'; bootstrapFile: string; effort?: string | null; hooks?: HookSettings | null }): string
export function buildCodexServerlessCommand(opts: { cmd?: string; bootstrapFile: string; lowThinking?: boolean }): string
export function buildAgentCommand(opts: { runtime?: AgentRuntime | string; cmd?: string; claudeSid?: string; mode?: 'create' | 'resume'; bootstrapFile: string; effort?: string | null; hooks?: HookSettings | null }): string
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
export const RESIDENT_EFFORT: string
export const AGENT_RUNTIME_CLAUDE: 'claude'
export const AGENT_RUNTIME_CODEX_SERVERLESS: 'codex-serverless'
export const DEFAULT_AGENT_RUNTIME: 'claude'
