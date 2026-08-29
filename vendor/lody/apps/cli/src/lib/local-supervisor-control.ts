import { z } from 'zod';
import {
  isLocalCliSupervisorShutdownMessage,
  LOCAL_CLI_SUPERVISOR_CONTRACT_VERSION,
  LODY_SUPERVISOR_CONTRACT_ENV,
  LODY_SUPERVISOR_INSTANCE_ID_ENV,
  LODY_SUPERVISOR_PID_ENV,
  LODY_SUPERVISOR_TOKEN_ENV,
} from '@lody/shared/node/local-cli-supervisor';
import type { CliRuntimeState } from '@lody/shared';
import type { Logger } from '@/utils/logger';

const SupervisorIdentitySchema = z
  .object({
    instanceId: z.string().trim().min(1),
    pid: z.coerce.number().int().positive(),
    token: z.string().trim().min(32),
    launchMode: z.enum(['daemon', 'electron']),
  })
  .strict();

export type LocalSupervisorIdentity = z.infer<typeof SupervisorIdentitySchema>;

export type LocalSupervisorIdentityResolution =
  | { status: 'unsupervised' }
  | { status: 'supervised'; identity: LocalSupervisorIdentity }
  | { status: 'invalid'; reason: string };

/**
 * A launch marker without a complete, contract-matched identity means the
 * supervising host and this worker come from incompatible releases. Callers
 * must fail closed with `CLI_EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH`; guessing
 * a launch mode here would grant or drop lifecycle capability incorrectly.
 */
export function resolveLocalSupervisorIdentity(
  env: NodeJS.ProcessEnv = process.env
): LocalSupervisorIdentityResolution {
  const daemonSupervised = env.LODY_DAEMON_SUPERVISED === '1';
  const electronSupervised = env.LODY_ELECTRON_BOOTSTRAP === '1';
  if (daemonSupervised && electronSupervised) {
    return {
      status: 'invalid',
      reason: 'Conflicting daemon and Electron supervisor launch markers',
    };
  }
  const launchMode = daemonSupervised ? 'daemon' : electronSupervised ? 'electron' : null;
  if (!launchMode) return { status: 'unsupervised' };

  const contractVersion = env[LODY_SUPERVISOR_CONTRACT_ENV];
  if (contractVersion !== LOCAL_CLI_SUPERVISOR_CONTRACT_VERSION) {
    return {
      status: 'invalid',
      reason: `The ${launchMode} supervisor speaks contract version ${contractVersion ?? '(none)'}, but this worker requires version ${LOCAL_CLI_SUPERVISOR_CONTRACT_VERSION}`,
    };
  }

  const parsed = SupervisorIdentitySchema.safeParse({
    instanceId: env[LODY_SUPERVISOR_INSTANCE_ID_ENV],
    pid: env[LODY_SUPERVISOR_PID_ENV],
    token: env[LODY_SUPERVISOR_TOKEN_ENV],
    launchMode,
  });
  if (!parsed.success) {
    return { status: 'invalid', reason: `Invalid ${launchMode} supervisor identity` };
  }
  return { status: 'supervised', identity: parsed.data };
}

export function scrubLocalSupervisorCapabilityEnv(env: NodeJS.ProcessEnv = process.env): void {
  delete env[LODY_SUPERVISOR_INSTANCE_ID_ENV];
  delete env[LODY_SUPERVISOR_PID_ENV];
  delete env[LODY_SUPERVISOR_TOKEN_ENV];
  delete env[LODY_SUPERVISOR_CONTRACT_ENV];
  delete env.LODY_DAEMON_SUPERVISED;
}

export function toRuntimeSupervisorIdentity(
  identity: LocalSupervisorIdentity | null
): CliRuntimeState['supervisor'] {
  if (!identity) return undefined;
  return {
    instanceId: identity.instanceId,
    pid: identity.pid,
    launchMode: identity.launchMode,
  };
}

export function registerLocalSupervisorControl(options: {
  identity: LocalSupervisorIdentity | null;
  logger: Logger;
  shutdown: (reason: string) => void;
  messageSource?: {
    on: (event: 'message' | 'disconnect', listener: (message?: unknown) => void) => unknown;
    off: (event: 'message' | 'disconnect', listener: (message?: unknown) => void) => unknown;
    send?: unknown;
    connected?: boolean;
  };
}): () => void {
  const identity = options.identity;
  if (!identity) return () => {};
  const messageSource =
    options.messageSource ??
    ({
      on: (event, listener) => {
        if (event === 'message') process.on('message', listener);
        else process.on('disconnect', listener);
      },
      off: (event, listener) => {
        if (event === 'message') process.off('message', listener);
        else process.off('disconnect', listener);
      },
      send: process.send,
      connected: process.connected,
    } satisfies NonNullable<(typeof options)['messageSource']>);

  let shutdownRequested = false;
  const requestShutdown = (reason: string) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    options.logger.info(reason);
    options.shutdown(reason);
  };
  const onMessage = (message: unknown) => {
    if (!isLocalCliSupervisorShutdownMessage(message)) return;
    if (message.instanceId !== identity.instanceId || message.token !== identity.token) return;
    requestShutdown('Supervisor requested graceful shutdown over the private IPC channel.');
  };
  const onDisconnect = () => {
    requestShutdown('Supervisor IPC channel disconnected; stopping orphaned worker.');
  };

  messageSource.on('message', onMessage);
  messageSource.on('disconnect', onDisconnect);
  if (typeof messageSource.send !== 'function' || messageSource.connected !== true) {
    queueMicrotask(onDisconnect);
  }

  return () => {
    messageSource.off('message', onMessage);
    messageSource.off('disconnect', onDisconnect);
  };
}
