import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import type { MemoryPressureSnapshot } from '@/utils/memory';
import { MemoryPressureSampler } from './memory-pressure-sampler';

const snapshot = (availableMemoryBytes: number): MemoryPressureSnapshot => ({
  availableMemoryBytes,
  effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
});

const logger = { debug: vi.fn() } as unknown as Logger;

describe('MemoryPressureSampler', () => {
  it('coalesces concurrent OS probes', async () => {
    let resolveProbe: ((value: MemoryPressureSnapshot) => void) | undefined;
    const probe = vi.fn(
      async () =>
        await new Promise<MemoryPressureSnapshot>((resolve) => {
          resolveProbe = resolve;
        })
    );
    const sampler = new MemoryPressureSampler(logger, { probe });

    const first = sampler.refresh();
    const second = sampler.refresh();
    expect(probe).toHaveBeenCalledTimes(1);

    const sampled = snapshot(4_000);
    resolveProbe?.(sampled);
    await expect(first).resolves.toBe(sampled);
    await expect(second).resolves.toBe(sampled);
  });

  it('returns a recent snapshot immediately and refreshes aging data in background', async () => {
    let now = 0;
    const first = snapshot(4_000);
    const second = snapshot(3_000);
    const probe = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const sampler = new MemoryPressureSampler(logger, {
      probe,
      now: () => now,
      sampleIntervalMs: 100,
      maxStaleMs: 300,
    });

    await sampler.refresh();
    now = 150;
    await expect(sampler.getLatest()).resolves.toBe(first);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    await expect(sampler.getLatest()).resolves.toBe(second);
  });

  it('only forces a fresh OS reading when it is about to act on one', async () => {
    // The Windows commit probe is a `powershell.exe` spawn with its own cache; the periodic
    // sweep must be allowed to reuse it, and only the act-on-it path may bypass it.
    const probe = vi.fn(async () => snapshot(4_000));
    const sampler = new MemoryPressureSampler(logger, { probe });

    await sampler.getLatest();
    expect(probe).toHaveBeenLastCalledWith(false);

    await sampler.refresh();
    expect(probe).toHaveBeenLastCalledWith(true);
  });

  it('does not let a forced sample adopt an in-flight unforced one', async () => {
    const resolvers: Array<(value: MemoryPressureSnapshot) => void> = [];
    const probe = vi.fn(
      async () =>
        await new Promise<MemoryPressureSnapshot>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const sampler = new MemoryPressureSampler(logger, { probe });

    const background = sampler.getLatest();
    const forced = sampler.refresh();

    expect(probe.mock.calls.map(([force]) => force)).toEqual([false, true]);

    const stale = snapshot(4_000);
    const fresh = snapshot(1_000);
    resolvers[0]?.(stale);
    resolvers[1]?.(fresh);
    await expect(background).resolves.toBe(stale);
    await expect(forced).resolves.toBe(fresh);
  });

  it('waits for a fresh probe when the cached snapshot exceeds the stale bound', async () => {
    let now = 0;
    const first = snapshot(4_000);
    const second = snapshot(2_000);
    const probe = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const sampler = new MemoryPressureSampler(logger, {
      probe,
      now: () => now,
      sampleIntervalMs: 100,
      maxStaleMs: 300,
    });

    await sampler.refresh();
    now = 301;

    await expect(sampler.getLatest()).resolves.toBe(second);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
