// Types for the shared agent-runtime core (agent-runtime.mjs).
export function buildBootstrap(url: string, sessionId?: string, bootTask?: string | null, workspace?: string | null): string
/** Register the per-agent standing-duty provider (e.g. the onboarding interview). Re-read on every
 *  (re)launch by prepareAgentLaunch; return null for no duty. Policy-free: the text is the caller's. */
export function setBootTaskProvider(fn: ((sessionId: string) => string | null | undefined) | null): void
export function shellQuote(s: string): string
export function buildClaudeCommand(opts: { cmd?: string; claudeSid: string; mode?: 'create' | 'resume'; bootstrapFile: string }): string
export function ensureClaudeSessionId(sessionsDir: string, id: string): { claudeSessionId: string; established: boolean }
export function prepareAgentLaunch(opts: { sessionsDir: string; id: string; url: string | null | undefined; cmd?: string }): { command: string; claudeSessionId: string }
export function writeRelayUrl(blitzDir: string, url: string | null | undefined): void
export const RELAY_URL_FILE: string
