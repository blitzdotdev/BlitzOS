/**
 * ACP / session-lifecycle analytics helpers (spec §8c, §5b).
 *
 * Thin wrappers over the CLI PostHog poster (`captureCli`) plus reason-code
 * classification shared across the ACP startup pipeline. Kept in one place so
 * spawn/init/session-establish/timeout call sites map errors to the canonical
 * `CLI_REASONS` / `ACP_REASONS` enums (spec §2.4) identically.
 *
 * Side-effect-only: every export swallows its own errors and never throws into
 * the agent runtime. `captureCli` is already a no-op when analytics is disabled
 * (no PostHog key), so call sites do not need to guard.
 */

import {
  type AcpReason,
  type CliReason,
  hashAnalyticsId,
  type AgentConfigCliType,
} from '@lody/shared';
import { captureCli } from '@/lib/analytics/posthog';

export type AcpLauncher = 'npx' | 'uvx' | 'local';

/**
 * Resolve the launcher family from the resolved exec command. Registry agents
 * launch via `npx`/`uvx`; everything else (resolved absolute bin, custom local
 * command) is bucketed as `local`. Non-PII: only the launcher family is emitted,
 * never the command path/args.
 */
export function resolveAcpLauncher(command: string | undefined): AcpLauncher {
  const trimmed = (command ?? '').trim().toLowerCase();
  if (trimmed === 'npx' || trimmed.endsWith('/npx') || trimmed.endsWith('\\npx')) return 'npx';
  if (trimmed === 'uvx' || trimmed.endsWith('/uvx') || trimmed.endsWith('\\uvx')) return 'uvx';
  return 'local';
}

function getErrnoCode(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    if (typeof causeCode === 'string') return causeCode;
  }
  return undefined;
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

/**
 * Classify a process-spawn failure into the shared `CLI_REASONS` enum. ENOENT =
 * binary not found (missing CLI/launcher), EACCES = not executable, timeout from
 * the ACP timeout wrapper, otherwise process_error.
 */
export function classifyCliSpawnReason(error: unknown): CliReason {
  const code = getErrnoCode(error);
  if (code === 'ENOENT') return 'enoent';
  if (code === 'EACCES' || code === 'EPERM') return 'eacces';
  const text = getErrorText(error).toLowerCase();
  if (code === 'ETIMEDOUT' || text.includes('acp_timeout') || text.includes('timed out')) {
    return 'timeout';
  }
  if (text.includes('enoent')) return 'enoent';
  if (text.includes('eacces')) return 'eacces';
  if (text) return 'process_error';
  return 'unknown';
}

/**
 * Classify an ACP protocol/init failure into the shared `ACP_REASONS` enum.
 * Spawn-level errno codes (ENOENT/EACCES) take priority; ACP timeout wrapper →
 * timeout; JSON-RPC / parse / protocol-version mismatches → protocol_error;
 * stream/connection drops → transport_error.
 */
export function classifyAcpProtocolReason(error: unknown): AcpReason {
  const code = getErrnoCode(error);
  if (code === 'ENOENT') return 'enoent';
  if (code === 'EACCES' || code === 'EPERM') return 'eacces';
  const text = getErrorText(error).toLowerCase();
  if (code === 'ETIMEDOUT' || text.includes('acp_timeout') || text.includes('timed out')) {
    return 'timeout';
  }
  if (
    text.includes('protocol') ||
    text.includes('parse error') ||
    text.includes('invalid request') ||
    text.includes('method not found') ||
    text.includes('jsonrpc') ||
    text.includes('json-rpc')
  ) {
    return 'protocol_error';
  }
  if (
    text.includes('stream') ||
    text.includes('connection') ||
    text.includes('disconnect') ||
    text.includes('exited before startup') ||
    text.includes('failed before startup') ||
    text.includes('epipe') ||
    text.includes('econnreset')
  ) {
    return 'transport_error';
  }
  if (text.includes('enoent')) return 'enoent';
  if (text.includes('eacces')) return 'eacces';
  if (text) return 'process_error';
  return 'unknown';
}

type AcpAgentProps = {
  cliType?: AgentConfigCliType;
  agentType?: string;
  launcher?: AcpLauncher;
  isResume?: boolean;
  sessionId?: string;
  workspaceId?: string;
};

function baseAcpProps(props: AcpAgentProps): Record<string, unknown> {
  return {
    ...(props.cliType ? { cli_type: props.cliType } : {}),
    ...(props.agentType ? { agent_type: props.agentType } : {}),
    ...(props.launcher ? { launcher: props.launcher } : {}),
    ...(typeof props.isResume === 'boolean' ? { is_resume: props.isResume } : {}),
    // session_id/workspace_id are non-PII surrogates; hash only the optional
    // workspace path/slug surfaces upstream — these ids are already opaque.
    ...(props.sessionId ? { session_id: props.sessionId } : {}),
    ...(props.workspaceId ? { workspace_id: props.workspaceId } : {}),
  };
}

/** acp/agent_spawn_started (tier A — startup funnel step). */
export function captureAcpSpawnStarted(props: AcpAgentProps): void {
  captureCli('acp/agent_spawn_started', baseAcpProps(props), { tier: 'A' });
}

/** acp/agent_spawn_failed (tier A — churn/`*_failed`). reason ∈ CLI_REASONS. */
export function captureAcpSpawnFailed(props: AcpAgentProps & { reason: CliReason }): void {
  captureCli(
    'acp/agent_spawn_failed',
    { ...baseAcpProps(props), reason: props.reason },
    { tier: 'A' }
  );
}

/** acp/protocol_init_completed (tier A — startup funnel step). */
export function captureAcpProtocolInitCompleted(
  props: AcpAgentProps & { initDurationMs: number; supportsResume: boolean }
): void {
  captureCli(
    'acp/protocol_init_completed',
    {
      ...baseAcpProps(props),
      init_duration_ms: Math.round(props.initDurationMs),
      supports_resume: props.supportsResume,
    },
    { tier: 'A' }
  );
}

/** acp/protocol_init_failed (tier A — churn). reason ∈ ACP_REASONS. */
export function captureAcpProtocolInitFailed(props: AcpAgentProps & { reason: AcpReason }): void {
  captureCli(
    'acp/protocol_init_failed',
    { ...baseAcpProps(props), reason: props.reason },
    { tier: 'A' }
  );
}

export type AcpSessionPath = 'new' | 'load' | 'resume' | 'fork';

/** acp/session_established (tier A — startup funnel step). */
export function captureAcpSessionEstablished(
  props: AcpAgentProps & {
    sessionPath: AcpSessionPath;
    availableModesCount: number;
    establishDurationMs: number;
  }
): void {
  captureCli(
    'acp/session_established',
    {
      ...baseAcpProps(props),
      session_path: props.sessionPath,
      available_modes_count: props.availableModesCount,
      establish_duration_ms: Math.round(props.establishDurationMs),
    },
    { tier: 'A' }
  );
}

/** acp/session_establish_failed (tier A — churn). reason ∈ ACP_REASONS. */
export function captureAcpSessionEstablishFailed(
  props: AcpAgentProps & { sessionPath: AcpSessionPath; reason: AcpReason }
): void {
  captureCli(
    'acp/session_establish_failed',
    { ...baseAcpProps(props), session_path: props.sessionPath, reason: props.reason },
    { tier: 'A' }
  );
}

/** acp/startup_completed (tier A — startup funnel terminal). */
export function captureAcpStartupCompleted(
  props: AcpAgentProps & {
    totalStartupMs: number;
    initDurationMs: number;
    sessionEstablishDurationMs: number;
    sessionPath: AcpSessionPath;
  }
): void {
  captureCli(
    'acp/startup_completed',
    {
      ...baseAcpProps(props),
      total_startup_ms: Math.round(props.totalStartupMs),
      init_duration_ms: Math.round(props.initDurationMs),
      session_establish_duration_ms: Math.round(props.sessionEstablishDurationMs),
      session_path: props.sessionPath,
    },
    { tier: 'A' }
  );
}

/**
 * acp/startup_timeout (tier A — churn). `timed_out_operation` names the phase
 * that exceeded its hard timeout (initialize / new_session / load_session /
 * resume_session).
 */
export function captureAcpStartupTimeout(
  props: AcpAgentProps & { timedOutOperation: string }
): void {
  captureCli(
    'acp/startup_timeout',
    { ...baseAcpProps(props), timed_out_operation: props.timedOutOperation },
    { tier: 'A' }
  );
}

/**
 * Hash a repo/branch/path surface before it can reach an analytics property.
 * Re-exported here so ACP call sites have a single import for both capture and
 * id hashing (spec §2.3 denylist guard).
 */
export function hashRepoSurface(value: string | null | undefined): string {
  return hashAnalyticsId(value);
}
