/**
 * One-shot client for the daemon's local-project control endpoint.
 *
 * Shared by `lody project` and `lody app`: both need the same
 * "daemon down is a response, not a throw" behavior plus the workspace
 * candidate handling that `workspace_required` errors carry.
 */
import inquirer from 'inquirer';
import type { LocalProjectControlRequest, LocalProjectControlResponse } from '@lody/shared';
import { Effect } from 'effect';
import { makeLocalControlClientAuto } from '@lody/shared/node/local-ipc';
import { DAEMON_NOT_RUNNING_MESSAGE, ensureDaemonReachable } from '@/lib/command-runtime';
import { getLogger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

const LOCAL_CONTROL_TIMEOUT_MS = 15_000;

export type WorkspaceCandidate = {
  id: string;
  slug: string | null;
  name: string;
};

export async function sendLocalProjectControl(
  message: LocalProjectControlRequest
): Promise<LocalProjectControlResponse> {
  try {
    await ensureDaemonReachable();
  } catch (error) {
    return {
      ok: false,
      type: message.type,
      error: 'daemon_unavailable',
      message: error instanceof Error ? error.message : DAEMON_NOT_RUNNING_MESSAGE,
    };
  }

  try {
    return await Effect.runPromise(
      makeLocalControlClientAuto()
        .projectControl(message, {
          timeoutMs: LOCAL_CONTROL_TIMEOUT_MS,
        })
        .pipe(
          Effect.catchTag('IpcTimeoutError', () =>
            Effect.succeed({
              ok: false,
              type: message.type,
              error: 'daemon_unavailable',
              message: 'Timed out while waiting for local CLI daemon',
            } satisfies LocalProjectControlResponse)
          ),
          Effect.catchTag('IpcProtocolError', (error) =>
            Effect.succeed({
              ok: false,
              type: message.type,
              error: 'invalid_response',
              message:
                typeof error.status === 'number'
                  ? `Invalid response payload (HTTP ${error.status})`
                  : error.message,
            } satisfies LocalProjectControlResponse)
          )
        )
    );
  } catch (error) {
    return {
      ok: false,
      type: message.type,
      error: 'daemon_unavailable',
      message: formatErrorMessage(error),
    };
  }
}

export function extractWorkspaceCandidates(
  response: Extract<LocalProjectControlResponse, { ok: false }>
): WorkspaceCandidate[] | null {
  if (response.error !== 'workspace_required') {
    return null;
  }

  const data = response.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }

  const rawCandidates = (data as { candidates?: unknown }).candidates;
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    return null;
  }

  const candidates: WorkspaceCandidate[] = [];
  for (const item of rawCandidates) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const candidate = item as { id?: unknown; slug?: unknown; name?: unknown };
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') {
      continue;
    }
    candidates.push({
      id: candidate.id,
      slug: typeof candidate.slug === 'string' ? candidate.slug : null,
      name: candidate.name,
    });
  }

  return candidates.length > 0 ? candidates : null;
}

export function printWorkspaceCandidates(
  candidates: WorkspaceCandidate[],
  loggerName: string
): void {
  const logger = getLogger(loggerName);
  logger.info('Available workspaces:');
  for (const item of candidates) {
    const slug = item.slug ? ` (${item.slug})` : '';
    logger.info(`- ${item.name}${slug}`);
  }
  logger.info('Use --workspace <id|slug|name>.');
}

export async function promptWorkspaceSelection(
  candidates: WorkspaceCandidate[],
  loggerName: string
): Promise<string | null> {
  const logger = getLogger(loggerName);
  const choices: Array<{ name: string; value: string }> = candidates.map((candidate) => {
    const slug = candidate.slug ? ` (${candidate.slug})` : '';
    return {
      name: `${candidate.name}${slug}`,
      value: candidate.id,
    };
  });

  try {
    const answer = await inquirer.prompt<{ selection: string }>([
      {
        type: 'list',
        name: 'selection',
        message: 'Multiple workspaces are active. Choose target workspace:',
        choices,
        pageSize: Math.min(choices.length + 2, 12),
      },
    ]);
    return answer.selection;
  } catch (error) {
    logger.error(`Workspace selection aborted: ${formatErrorMessage(error)}`);
    return null;
  }
}
