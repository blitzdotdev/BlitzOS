import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import {
  SessionPreparationService,
  type SessionPreparationResource,
} from './session-preparation-service';

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: unknown): void } {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createResource() {
  const initialized = deferred();
  const sessionReady = deferred();
  const dispose = vi.fn(async () => undefined);
  return {
    resource: {
      initialized: initialized.promise,
      sessionReady: sessionReady.promise,
      dispose,
    } satisfies SessionPreparationResource,
    initialized,
    sessionReady,
    dispose,
  };
}

describe('SessionPreparationService', () => {
  const services: SessionPreparationService<SessionPreparationResource>[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(services.map(async (service) => await service.disposeAll()));
    services.length = 0;
  });

  function createService(options?: { hardTtlMs?: number; maxConcurrent?: number }) {
    const service = new SessionPreparationService<SessionPreparationResource>(
      { debug: vi.fn() },
      {
        hardTtlMs: options?.hardTtlMs ?? 120_000,
        maxConcurrent: options?.maxConcurrent ?? 1,
      }
    );
    services.push(service);
    return service;
  }

  it('tracks initialize and session-ready milestones without blocking start acknowledgement', async () => {
    const service = createService();
    const prepared = createResource();
    const sessionId = 'session-1' as SessionId;

    expect(
      service.start({
        preparationId: 'prepare-1',
        sessionId,
        requesterUserId: 'user-1',
        requestKey: 'key-1',
        create: async () => prepared.resource,
      })
    ).toBe('accepted');
    expect(service.getState(sessionId)).toBe('preparing');

    prepared.initialized.resolve();
    await vi.waitFor(() => expect(service.getState(sessionId)).toBe('initialized'));

    prepared.sessionReady.resolve();
    await vi.waitFor(() => expect(service.getState(sessionId)).toBe('session-ready'));
  });

  it('publishes a resource before starting its side effects', async () => {
    const service = createService();
    const prepared = createResource();
    const sessionId = 'session-published-before-start' as SessionId;
    let visibleAtStart: SessionPreparationResource | null = null;
    prepared.resource.start = vi.fn(() => {
      visibleAtStart = service.peek({
        sessionId,
        requesterUserId: 'user-1',
        claimKey: 'key-published-before-start',
      });
    });

    service.start({
      preparationId: 'prepare-published-before-start',
      sessionId,
      requesterUserId: 'user-1',
      requestKey: 'key-published-before-start',
      create: async () => prepared.resource,
    });

    await vi.waitFor(() => expect(prepared.resource.start).toHaveBeenCalledTimes(1));
    expect(visibleAtStart).toBe(prepared.resource);
  });

  it('atomically transfers ownership on a compatible claim', async () => {
    const service = createService();
    const prepared = createResource();
    const sessionId = 'session-2' as SessionId;
    service.start({
      preparationId: 'prepare-2',
      sessionId,
      requesterUserId: 'user-1',
      requestKey: 'key-2',
      create: async () => prepared.resource,
    });
    prepared.initialized.resolve();
    await vi.waitFor(() => expect(service.getState(sessionId)).toBe('initialized'));

    expect(
      service.claim({
        sessionId,
        requesterUserId: 'user-1',
        claimKey: 'key-2',
        isCompatible: () => true,
      })
    ).toEqual({ status: 'claimed', resource: prepared.resource });
    expect(
      service.claim({
        sessionId,
        requesterUserId: 'user-1',
        claimKey: 'key-2',
        isCompatible: () => true,
      })
    ).toEqual({ status: 'miss', cleanup: null });
    expect(service.getState(sessionId)).toBeNull();
    expect(
      service.cancel({
        preparationId: 'prepare-2',
        sessionId,
        requesterUserId: 'user-1',
      })
    ).toBe('not-found');
    expect(prepared.dispose).not.toHaveBeenCalled();
  });

  it('peeks at a published resource without transferring ownership', async () => {
    const service = createService();
    const prepared = createResource();
    const sessionId = 'session-peek' as SessionId;
    service.start({
      preparationId: 'prepare-peek',
      sessionId,
      requesterUserId: 'user-1',
      requestKey: 'key-peek',
      create: async () => prepared.resource,
    });
    await vi.waitFor(() => expect(service.getState(sessionId)).toBe('preparing'));
    await vi.waitFor(() =>
      expect(service.peek({ sessionId, requesterUserId: 'user-1', claimKey: 'key-peek' })).toBe(
        prepared.resource
      )
    );

    expect(service.peek({ sessionId, requesterUserId: 'user-2', claimKey: 'key-peek' })).toBeNull();
    expect(
      service.peek({ sessionId, requesterUserId: 'user-1', claimKey: 'wrong-key' })
    ).toBeNull();
    expect(service.getState(sessionId)).toBe('preparing');

    expect(
      service.claim({
        sessionId,
        requesterUserId: 'user-1',
        claimKey: 'key-peek',
        isCompatible: () => true,
      })
    ).toEqual({ status: 'claimed', resource: prepared.resource });
  });

  it('never waits for an unpublished preparation on the send path', async () => {
    const service = createService();
    const prepared = createResource();
    const createStarted = deferred();
    const releaseCreate = deferred();
    const sessionId = 'session-cold-fallback' as SessionId;
    service.start({
      preparationId: 'prepare-cold-fallback',
      sessionId,
      requesterUserId: 'user-1',
      requestKey: 'key-cold-fallback',
      create: async () => {
        createStarted.resolve();
        await releaseCreate.promise;
        return prepared.resource;
      },
    });
    await createStarted.promise;

    expect(
      service.claim({
        sessionId,
        requesterUserId: 'user-1',
        claimKey: 'key-cold-fallback',
        isCompatible: () => true,
      })
    ).toEqual({ status: 'miss', cleanup: null });
    releaseCreate.resolve();
    await vi.waitFor(() => expect(prepared.dispose).toHaveBeenCalledTimes(1));
  });

  it("replaces only the same requester's lease and disposes the previous resource", async () => {
    const service = createService();
    const first = createResource();
    const second = createResource();
    service.start({
      preparationId: 'prepare-first',
      sessionId: 'session-first' as SessionId,
      requesterUserId: 'user-1',
      requestKey: 'key-first',
      create: async () => first.resource,
    });
    first.initialized.resolve();
    await vi.waitFor(() =>
      expect(service.getState('session-first' as SessionId)).toBe('initialized')
    );

    expect(
      service.start({
        preparationId: 'prepare-second',
        sessionId: 'session-second' as SessionId,
        requesterUserId: 'user-1',
        requestKey: 'key-second',
        create: async () => second.resource,
      })
    ).toBe('replaced');
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledTimes(1));
  });

  it('treats changed preparation config as a replacement while retaining claim identity', async () => {
    const service = createService();
    const first = createResource();
    const second = createResource();
    const sessionId = 'session-run-config-replacement' as SessionId;
    service.start({
      preparationId: 'prepare-config-first',
      sessionId,
      requesterUserId: 'user-1',
      requestKey: 'request:model-a',
      claimKey: 'claim:routing',
      create: async () => first.resource,
    });
    await vi.waitFor(() =>
      expect(
        service.peek({
          sessionId,
          requesterUserId: 'user-1',
          claimKey: 'claim:routing',
        })
      ).toBe(first.resource)
    );

    expect(
      service.start({
        preparationId: 'prepare-config-second',
        sessionId,
        requesterUserId: 'user-1',
        requestKey: 'request:model-b',
        claimKey: 'claim:routing',
        create: async () => second.resource,
      })
    ).toBe('replaced');
    expect(
      service.cancel({
        preparationId: 'prepare-config-first',
        sessionId,
        requesterUserId: 'user-1',
      })
    ).toBe('not-found');
    await vi.waitFor(() =>
      expect(
        service.peek({
          sessionId,
          requesterUserId: 'user-1',
          claimKey: 'claim:routing',
        })
      ).toBe(second.resource)
    );
  });

  it('serializes replacement startup behind predecessor cleanup', async () => {
    const service = createService();
    const first = createResource();
    const second = createResource();
    const cleanupGate = deferred();
    first.dispose.mockImplementation(async () => await cleanupGate.promise);
    const secondCreate = vi.fn(async () => second.resource);
    const firstSessionId = 'session-serial-first' as SessionId;
    service.start({
      preparationId: 'prepare-serial-first',
      sessionId: firstSessionId,
      requesterUserId: 'user-1',
      requestKey: 'key-serial-first',
      create: async () => first.resource,
    });
    first.initialized.resolve();
    await vi.waitFor(() => expect(service.getState(firstSessionId)).toBe('initialized'));

    service.start({
      preparationId: 'prepare-serial-second',
      sessionId: 'session-serial-second' as SessionId,
      requesterUserId: 'user-1',
      requestKey: 'key-serial-second',
      create: secondCreate,
    });
    await Promise.resolve();
    expect(secondCreate).not.toHaveBeenCalled();

    cleanupGate.resolve();
    await vi.waitFor(() => expect(secondCreate).toHaveBeenCalledTimes(1));
  });

  it('expires and disposes an abandoned lease at the hard TTL', async () => {
    vi.useFakeTimers();
    const service = createService({ hardTtlMs: 100 });
    const prepared = createResource();
    const sessionId = 'session-expiring' as SessionId;
    service.start({
      preparationId: 'prepare-expiring',
      sessionId,
      requesterUserId: 'user-1',
      requestKey: 'key-expiring',
      create: async () => prepared.resource,
    });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(100);
    expect(service.getState(sessionId)).toBeNull();
    expect(prepared.dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects a second requester while the bounded preparation slot is occupied', async () => {
    const service = createService({ maxConcurrent: 1 });
    const first = createResource();
    const second = createResource();
    service.start({
      preparationId: 'prepare-owner',
      sessionId: 'session-owner' as SessionId,
      requesterUserId: 'user-1',
      requestKey: 'key-owner',
      create: async () => first.resource,
    });

    expect(
      service.start({
        preparationId: 'prepare-other',
        sessionId: 'session-other' as SessionId,
        requesterUserId: 'user-2',
        requestKey: 'key-other',
        create: async () => second.resource,
      })
    ).toBe('busy');
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it('disposes an incompatible published preparation before falling back', async () => {
    const service = createService();
    const prepared = createResource();
    const cleanupGate = deferred();
    prepared.dispose.mockImplementation(async () => await cleanupGate.promise);
    const sessionId = 'session-incompatible' as SessionId;
    service.start({
      preparationId: 'prepare-incompatible',
      sessionId,
      requesterUserId: 'user-1',
      requestKey: 'key-incompatible',
      create: async () => prepared.resource,
    });
    prepared.initialized.resolve();
    await vi.waitFor(() => expect(service.getState(sessionId)).toBe('initialized'));

    const result = service.claim({
      sessionId,
      requesterUserId: 'user-1',
      claimKey: 'key-incompatible',
      isCompatible: () => false,
    });
    expect(result.status).toBe('miss');
    if (result.status === 'miss') {
      expect(result.cleanup).not.toBeNull();
      expect(prepared.dispose).toHaveBeenCalledTimes(1);
      cleanupGate.resolve();
      await result.cleanup;
    }
    expect(prepared.dispose).toHaveBeenCalledTimes(1);
  });
});
