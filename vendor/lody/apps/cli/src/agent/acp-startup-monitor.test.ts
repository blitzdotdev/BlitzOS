import { describe, expect, it } from 'vitest';

import { createAcpStartupMonitor } from './acp-startup-monitor';

function createFakeMonitoredProcess() {
  const exitListeners = new Set<(exitCode: number | null, signal: NodeJS.Signals | null) => void>();
  const errorListeners = new Set<(error: Error) => void>();

  return {
    processHandle: {
      onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void) {
        exitListeners.add(listener);
        return () => {
          exitListeners.delete(listener);
        };
      },
      onError(listener: (error: Error) => void) {
        errorListeners.add(listener);
        return () => {
          errorListeners.delete(listener);
        };
      },
    },
    emitExit(exitCode: number | null, signal: NodeJS.Signals | null) {
      for (const listener of Array.from(exitListeners)) {
        listener(exitCode, signal);
      }
    },
    emitError(error: Error) {
      for (const listener of Array.from(errorListeners)) {
        listener(error);
      }
    },
  };
}

describe('createAcpStartupMonitor', () => {
  it('rejects startup immediately when the ACP process exits early', async () => {
    const fakeProcess = createFakeMonitoredProcess();
    let stderrTail = '';
    const monitor = createAcpStartupMonitor(fakeProcess.processHandle, {
      sessionId: 'session-1',
      command: 'claude-agent-acp',
      args: [],
      getStderrTail: () => stderrTail,
    });

    stderrTail = `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'`;
    fakeProcess.emitExit(1, null);

    await expect(monitor.abortPromise).rejects.toThrow(/Cannot find package 'zod'/);
  });

  it('rejects startup when process creation emits an error', async () => {
    const fakeProcess = createFakeMonitoredProcess();
    const monitor = createAcpStartupMonitor(fakeProcess.processHandle, {
      sessionId: 'session-2',
      command: 'claude-agent-acp',
      args: ['--debug'],
    });

    fakeProcess.emitError(new Error('spawn ENOENT'));

    await expect(monitor.abortPromise).rejects.toThrow(/spawn ENOENT/);
  });
});
