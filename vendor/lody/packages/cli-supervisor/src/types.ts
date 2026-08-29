import type { ChildProcess } from 'node:child_process';
import type { CliRuntimeState } from '@lody/shared/electron-ipc';

export type CliRunResult = {
  code: number | null;
  signal?: NodeJS.Signals | null;
  terminationKind?: 'exit' | 'signal' | 'v8_oom';
  stdout: string;
  stderr: string;
};

export type LaunchHandle = {
  child: ChildProcess;
  /** Resolves when the owned process has exited, not merely when a signal was sent. */
  result: Promise<CliRunResult>;
  /** Cross-platform graceful shutdown channel. OS signals remain the timeout fallback. */
  requestShutdown?: () => void | Promise<void>;
};

/**
 * Preparation may perform cancellable async work, but it must never spawn.
 * The supervisor calls spawn synchronously only after revalidating its generation.
 */
export type PreparedLaunch = {
  spawn: () => LaunchHandle;
};

export type SupervisorExitDecision =
  | { action: 'stop'; message?: string }
  | { action: 'restart'; message?: string }
  | {
      action: 'retry';
      message?: string;
      countFailure: boolean;
      failureClass?: 'ordinary' | 'v8_oom';
    }
  | { action: 'fatal'; message: string };

export type SupervisorTermination = {
  reason: 'clean_exit' | 'fatal';
  result?: CliRunResult;
  message?: string;
};

export type SupervisorPhase =
  | 'stopped'
  | 'stopping'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'reconnecting'
  | 'offline'
  | 'fatal';

export type SupervisorState = {
  phase: SupervisorPhase;
  desiredState: 'running' | 'stopped';
  updatedAtMs: number;
  runtime?: CliRuntimeState;
  runtimeOwnership?: 'owned' | 'external';
  message?: string;
  retryAttempt?: number;
  retryInMs?: number;
  lastExitCode?: number | null;
  lastExitAtMs?: number;
};

export type SupervisorOptions = {
  prepareLaunch: (signal: AbortSignal) => Promise<PreparedLaunch>;
  decideExit: (
    result: CliRunResult,
    signal: AbortSignal
  ) => Promise<SupervisorExitDecision> | SupervisorExitDecision;
  onStateChange?: (state: SupervisorState) => void;
  onTerminal?: (termination: SupervisorTermination) => void;
  ownership?: SupervisorOwnership;
  /** Electron may observe a healthy runtime owned by a persistent host; daemon hosts reject it. */
  existingRuntimePolicy?: 'attach' | 'reject';
  terminationGraceMs?: number;
  forceKillWaitMs?: number;
  fetchRuntimeState: (options: { timeoutMs: number }) => Promise<CliRuntimeState | null>;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  probeFailureThreshold?: number;
  minRetryMs?: number;
  maxRetryMs?: number;
  retryJitterFraction?: number;
  retryRandom?: () => number;
  fatalFailureWindowMs?: number;
  fatalFailureThreshold?: number;
  fatalOomWindowMs?: number;
  fatalOomThreshold?: number;
  healthyRunMs?: number;
};

export type SupervisorStopOptions = {
  terminationGraceMs?: number;
};

export type SupervisorOwnership = {
  acquire: (
    signal: AbortSignal
  ) => Promise<
    | { status: 'acquired' }
    | { status: 'occupied'; description?: string; owner?: SupervisorHostIdentity }
  >;
  inspect?: () => Promise<SupervisorHostIdentity | null>;
  release: () => void | Promise<void>;
};

export type SupervisorHostIdentity = {
  instanceId: string;
  pid: number;
  mode: 'daemon' | 'electron' | 'foreground';
};
