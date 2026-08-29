import { describe, expect, it } from 'vitest';
import type { CliRuntimeState } from '@lody/shared';
import { formatDaemonBackendStatus } from './daemon-status-format';

const runtimeState = (overrides: Partial<CliRuntimeState> = {}): CliRuntimeState => ({
  schemaVersion: 1,
  phase: 'running',
  pid: 123,
  updatedAtMs: 1,
  issues: [],
  ...overrides,
});

describe('formatDaemonBackendStatus', () => {
  it('prints backend authorization, connection, and workspace details', () => {
    expect(
      formatDaemonBackendStatus(
        runtimeState({
          backend: { authorization: 'authorized', connection: 'connected' },
          connectedWorkspaces: [
            {
              id: 'workspace-1',
              name: 'Alpha',
              slug: 'alpha',
              role: 'owner',
              backendConnection: 'connected',
            },
          ],
        })
      )
    ).toEqual([
      '  Backend Auth: authorized',
      '  Backend Link: connected',
      '  Workspaces:   1',
      '    - Alpha (alpha) [owner]',
      '      ID: workspace-1',
      '      Backend: connected',
    ]);
  });

  it('does not claim backend state for an older daemon payload', () => {
    expect(formatDaemonBackendStatus(runtimeState())).toEqual([
      '  Backend Auth: unknown',
      '  Backend Link: unknown',
      '  Workspaces:   unavailable',
    ]);
  });
});
