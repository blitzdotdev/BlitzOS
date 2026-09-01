import { describe, expect, it } from 'vitest';
import { EphemeralStore, type Value } from 'loro-crdt';
import {
  getLodySessionViewingPresenceKey,
  parseLodyPresenceStates,
  type LodyPresenceInstanceId,
} from '@lody/shared';

/**
 * Milestone-0 proof for the CLI PR poller: a local `EphemeralStore` write is
 * encoded and broadcast by `EphemeralStoreAdaptor` — the same adaptor both the
 * CLI publisher (`CliPresenceRuntime`) and the web `WorkspacePresenceTransport`
 * wire into `EphemeralStreamCrdt`. Bridging two stores with encode/apply
 * exercises the exact wasm primitives the adaptor drives over the wire, so a
 * browser-side `store.set` is observed by every room peer.
 */
describe('session-viewing presence over EphemeralStore', () => {
  it('propagates set/delete between bridged stores and survives schema parsing', () => {
    const publisher = new EphemeralStore(90_000);
    const observer = new EphemeralStore(90_000);
    publisher.subscribeLocalUpdates((bytes) => {
      observer.apply(bytes);
    });

    const key = getLodySessionViewingPresenceKey('user-1', 'instance-1' as LodyPresenceInstanceId);
    const state = {
      kind: 'session-viewing',
      userId: 'user-1',
      instanceId: 'instance-1',
      sessionId: 'session-1',
      since: 1_000,
      updatedAt: 2_000,
    };

    publisher.set(key, state as unknown as Value);
    // The observer parses the entry through the same schema the CLI poller uses.
    expect(
      parseLodyPresenceStates(observer.getAllStates() as Record<string, unknown>)[key]
    ).toEqual(state);

    publisher.delete(key);
    expect(observer.getAllStates()[key]).toBeUndefined();

    publisher.destroy();
    observer.destroy();
  });
});
