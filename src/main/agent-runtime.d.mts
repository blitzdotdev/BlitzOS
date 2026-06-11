// Types for the shared agent-runtime core (agent-runtime.mjs).
export function buildBootstrap(url: string, sessionId?: string): string
export function shellQuote(s: string): string
export function buildClaudeCommand(opts: { cmd?: string; claudeSid: string; mode?: 'create' | 'resume'; bootstrapFile: string }): string
export function ensureClaudeSessionId(sessionsDir: string, id: string): { claudeSessionId: string; established: boolean }
export function prepareAgentLaunch(opts: { sessionsDir: string; id: string; url: string | null | undefined; cmd?: string }): { command: string; claudeSessionId: string }
export function writeRelayUrl(blitzDir: string, url: string | null | undefined): void
export const RELAY_URL_FILE: string
