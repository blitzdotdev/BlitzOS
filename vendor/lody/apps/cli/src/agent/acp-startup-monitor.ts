export class AcpStartupProcessExitError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string | null;

  constructor(options: {
    sessionId: string;
    command: string;
    args: string[];
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderrTail?: string | null;
  }) {
    const exitSummary =
      options.exitCode !== null
        ? `exit code ${options.exitCode}`
        : options.signal
          ? `signal ${options.signal}`
          : 'unknown reason';
    const stderrTail = options.stderrTail?.trim() || null;
    const commandSummary = [options.command, ...options.args].join(' ').trim();
    super(
      `[ACP_STARTUP_FAILED] ACP agent process exited before startup completed (${exitSummary}; command=${commandSummary || options.command})${
        stderrTail ? `; stderr tail: ${stderrTail}` : ''
      }`
    );
    this.name = 'AcpStartupProcessExitError';
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.stderrTail = stderrTail;
  }
}

export class AcpStartupProcessError extends Error {
  readonly stderrTail: string | null;

  constructor(options: {
    sessionId: string;
    command: string;
    args: string[];
    stderrTail?: string | null;
    cause: Error;
  }) {
    const stderrTail = options.stderrTail?.trim() || null;
    const commandSummary = [options.command, ...options.args].join(' ').trim();
    super(
      `[ACP_STARTUP_FAILED] ACP agent process failed before startup completed (command=${commandSummary || options.command}): ${options.cause.message}${
        stderrTail ? `; stderr tail: ${stderrTail}` : ''
      }`,
      { cause: options.cause }
    );
    this.name = 'AcpStartupProcessError';
    this.stderrTail = stderrTail;
  }
}

type ProcessExitListener = (exitCode: number | null, signal: NodeJS.Signals | null) => void;
type ProcessErrorListener = (error: Error) => void;

export interface StartupMonitoredProcess {
  onExit(listener: ProcessExitListener): () => void;
  onError(listener: ProcessErrorListener): () => void;
}

export interface AcpStartupMonitor {
  abortPromise: Promise<never>;
  dispose(): void;
}

export function appendStderrTail(
  currentTail: string,
  chunk: string,
  maxChars: number = 4000
): string {
  if (!chunk) {
    return currentTail;
  }

  const nextTail = `${currentTail}${chunk}`;
  if (nextTail.length <= maxChars) {
    return nextTail;
  }

  return nextTail.slice(nextTail.length - maxChars);
}

export function createAcpStartupMonitor(
  processHandle: StartupMonitoredProcess,
  options: {
    sessionId: string;
    command: string;
    args: string[];
    getStderrTail?: () => string;
  }
): AcpStartupMonitor {
  let active = true;
  let unsubscribeExit: (() => void) | null = null;
  let unsubscribeError: (() => void) | null = null;

  const cleanup = () => {
    if (!active) {
      return;
    }
    active = false;
    unsubscribeExit?.();
    unsubscribeError?.();
    unsubscribeExit = null;
    unsubscribeError = null;
  };

  const abortPromise = new Promise<never>((_, reject) => {
    const getStderrTail = () => options.getStderrTail?.().trim() || null;

    unsubscribeExit = processHandle.onExit((exitCode, signal) => {
      if (!active) {
        return;
      }
      cleanup();
      reject(
        new AcpStartupProcessExitError({
          sessionId: options.sessionId,
          command: options.command,
          args: options.args,
          exitCode,
          signal,
          stderrTail: getStderrTail(),
        })
      );
    });

    unsubscribeError = processHandle.onError((error) => {
      if (!active) {
        return;
      }
      cleanup();
      reject(
        new AcpStartupProcessError({
          sessionId: options.sessionId,
          command: options.command,
          args: options.args,
          stderrTail: getStderrTail(),
          cause: error,
        })
      );
    });
  });

  return {
    abortPromise,
    dispose: cleanup,
  };
}
