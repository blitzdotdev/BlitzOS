import { describe, expect, it } from 'vitest';
import { resolveCloudPlatformRuntimePolicy } from '../src/providers/cloud-platform-runtime-policy';

describe('resolveCloudPlatformRuntimePolicy', () => {
  it('uses cloud-only sync when an Electron user disables the local agent', () => {
    expect(
      resolveCloudPlatformRuntimePolicy({
        electron: true,
        localAgentEnabled: false,
      })
    ).toEqual({ ready: true, syncMode: 'cloud' });
  });

  it('uses dual sync when the Electron local agent is enabled', () => {
    expect(
      resolveCloudPlatformRuntimePolicy({
        electron: true,
        localAgentEnabled: true,
      })
    ).toEqual({ ready: true, syncMode: 'dual' });
  });

  it('waits before choosing the initial Electron runtime', () => {
    expect(
      resolveCloudPlatformRuntimePolicy({
        electron: true,
        localAgentEnabled: null,
      })
    ).toEqual({ ready: false, syncMode: 'dual' });
  });

  it('keeps non-Electron cloud clients on cloud sync', () => {
    expect(
      resolveCloudPlatformRuntimePolicy({
        electron: false,
        localAgentEnabled: null,
      })
    ).toEqual({ ready: true, syncMode: 'cloud' });
  });
});
