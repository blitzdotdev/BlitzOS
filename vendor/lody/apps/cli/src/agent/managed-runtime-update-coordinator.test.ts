import { describe, expect, it, vi } from 'vitest';

import {
  ManagedRuntimeUpdateCoordinator,
  type ManagedRuntimeUpdateManager,
} from './managed-runtime-update-coordinator';

function createDiagnostics(name: 'codex' | 'kimi-code') {
  return {
    runtimeName: name,
    version: '2.0.0',
    platformArch: name === 'kimi-code' ? 'node' : 'linux-x64',
    runtimeBaseHost: 'runtime.example.test',
    proxyEnvPresent: false,
    proxyConfiguredForRuntimeUrl: false,
  } as const;
}

describe('ManagedRuntimeUpdateCoordinator', () => {
  it('serializes startup updates and attempts each target version once per process', async () => {
    const calls: string[] = [];
    const manager: ManagedRuntimeUpdateManager = {
      listAvailableUpdates: vi.fn().mockResolvedValue(['codex', 'kimi-code']),
      getTargetVersion: vi.fn().mockReturnValue('2.0.0'),
      ensureCurrentRuntime: vi.fn(async (name) => {
        calls.push(`install:${name}`);
        return {
          runtimeName: name,
          version: '2.0.0',
          platformArch: name === 'kimi-code' ? 'node' : 'linux-x64',
          command: `/runtime/${name}`,
        };
      }),
      pruneSupersededVersions: vi.fn(async (name) => {
        calls.push(`prune:${name}`);
      }),
      getDiagnostics: vi.fn((name) => createDiagnostics(name as 'codex' | 'kimi-code')),
    };
    const logger = { debug: vi.fn(), error: vi.fn() };
    const coordinator = new ManagedRuntimeUpdateCoordinator(manager, logger);

    await coordinator.start();
    await coordinator.waitForIdle();
    coordinator.enqueue('codex');
    await coordinator.waitForIdle();

    expect(calls).toEqual(['install:codex', 'prune:codex', 'install:kimi-code', 'prune:kimi-code']);
    expect(manager.ensureCurrentRuntime).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
    await coordinator.shutdown();
  });

  it('records a background failure without retrying or blocking other runtimes', async () => {
    const calls: string[] = [];
    const manager: ManagedRuntimeUpdateManager = {
      listAvailableUpdates: vi.fn().mockResolvedValue(['codex', 'kimi-code']),
      getTargetVersion: vi.fn().mockReturnValue('2.0.0'),
      ensureCurrentRuntime: vi.fn(async (name) => {
        calls.push(`install:${name}`);
        if (name === 'codex') throw new Error('download failed');
        return {
          runtimeName: name,
          version: '2.0.0',
          platformArch: 'node',
          command: '/runtime/kimi-code',
        };
      }),
      pruneSupersededVersions: vi.fn(async (name) => {
        calls.push(`prune:${name}`);
      }),
      getDiagnostics: vi.fn((name) => createDiagnostics(name as 'codex' | 'kimi-code')),
    };
    const logger = { debug: vi.fn(), error: vi.fn() };
    const coordinator = new ManagedRuntimeUpdateCoordinator(manager, logger);

    await coordinator.start();
    await coordinator.waitForIdle();
    coordinator.enqueue('codex');
    await coordinator.waitForIdle();

    expect(calls).toEqual(['install:codex', 'install:kimi-code', 'prune:kimi-code']);
    expect(logger.error).toHaveBeenCalledTimes(1);
    await coordinator.shutdown();
  });
});
