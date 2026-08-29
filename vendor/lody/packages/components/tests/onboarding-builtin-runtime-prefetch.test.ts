import { beforeEach, describe, expect, it } from 'vitest';
import type { ManagedBuiltinAgentType } from '@lody/shared';

import { __onboardingBuiltinRuntimePrefetchForTests as prefetch } from '../src/components/onboarding/use-onboarding-builtin-runtime-prefetch';

describe('onboarding builtin runtime prefetch scheduling', () => {
  beforeEach(() => {
    prefetch.reset();
  });

  it('places the selected runtime first without changing the background order', () => {
    expect(prefetch.resolvePrefetchOrder(null)).toEqual(['kimi', 'codex', 'claude']);
    expect(prefetch.resolvePrefetchOrder('codex')).toEqual(['codex', 'kimi', 'claude']);
    expect(prefetch.resolvePrefetchOrder('claude')).toEqual(['claude', 'kimi', 'codex']);
  });

  it('finishes the running task before starting the newly preferred runtime', async () => {
    const createDeferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    };
    const kimiStarted = createDeferred();
    const kimiFinished = createDeferred();
    const codexStarted = createDeferred();
    const starts: ManagedBuiltinAgentType[] = [];
    const runTask = async (agentType: ManagedBuiltinAgentType): Promise<void> => {
      starts.push(agentType);
      if (agentType === 'kimi') {
        kimiStarted.resolve();
        await kimiFinished.promise;
      }
      if (agentType === 'codex') {
        codexStarted.resolve();
      }
    };

    const initial = prefetch.schedule(
      'workspace:machine',
      prefetch.resolvePrefetchOrder(null),
      runTask
    );
    await kimiStarted.promise;

    initial.dispose();
    prefetch.schedule(
      'workspace:machine',
      prefetch.resolvePrefetchOrder('codex'),
      runTask
    );
    expect(starts).toEqual(['kimi']);

    kimiFinished.resolve();
    await codexStarted.promise;
    expect(starts.slice(0, 2)).toEqual(['kimi', 'codex']);
  });
});
