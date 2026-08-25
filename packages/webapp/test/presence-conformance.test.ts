import type { PutPresenceConnectionRequest } from '@blitzos/schema';
import { describe, expect, it } from 'vitest';
import { decodePresenceSnapshotResponse, presenceViewForTabs } from '../src/presence';
import type { WorkspaceTab } from '../src/storage';

// Browser side of the `org presence` contract: the request producer
// (`presenceViewForTabs`) and the snapshot consumer
// (`decodePresenceSnapshotResponse`). The control plane pins the same corpus
// from the other side in packages/control-plane/test/presence-conformance.test.ts.
interface RequestFixture {
  producer: {
    workspaceId: string | null;
    tabs: WorkspaceTab[];
    visibleTabIds: number[];
    focusedTabId: number | null;
  } | null;
  body: PutPresenceConnectionRequest;
  status: number;
}

interface SnapshotFixture {
  response: unknown;
  accepts: boolean;
}

const requestFixtures = import.meta.glob<RequestFixture>(
  '../../schema/fixtures/presence/requests/*.json',
  { eager: true, import: 'default' },
);
const snapshotFixtures = import.meta.glob<SnapshotFixture>(
  '../../schema/fixtures/presence/snapshots/*.json',
  { eager: true, import: 'default' },
);

function named<T>(fixtures: Record<string, T>): Array<[string, T]> {
  return Object.entries(fixtures)
    .map(([path, fixture]): [string, T] => [path.slice(path.lastIndexOf('/') + 1), fixture])
    .sort(([left], [right]) => left.localeCompare(right));
}

describe('org presence fixtures (browser)', () => {
  it('produces exactly the pinned body for every browser-producible request', () => {
    let produced = 0;
    for (const [name, fixture] of named(requestFixtures)) {
      if (fixture.producer === null) continue;
      produced += 1;
      const { workspaceId, tabs, visibleTabIds, focusedTabId } = fixture.producer;
      expect(presenceViewForTabs(workspaceId, tabs, visibleTabIds, focusedTabId), name).toEqual({
        workspaceId: fixture.body.workspaceId,
        surfaces: fixture.body.surfaces,
        focusedSurface: fixture.body.focusedSurface,
      });
      expect(fixture.status, name).toBe(204);
    }
    expect(produced).toBeGreaterThanOrEqual(4);
  });

  it('accepts exactly the snapshots the corpus marks acceptable', () => {
    for (const [name, fixture] of named(snapshotFixtures)) {
      const decode = () => decodePresenceSnapshotResponse(JSON.stringify(fixture.response));
      if (fixture.accepts) expect(decode, name).not.toThrow();
      else expect(decode, name).toThrow();
    }
    // A redacted activity carries nothing that names the workspace.
    const redacted = snapshotFixtures['../../schema/fixtures/presence/snapshots/redacted.json'];
    const decoded = decodePresenceSnapshotResponse(JSON.stringify(redacted?.response));
    expect(decoded.members[0]?.activities).toEqual([
      expect.objectContaining({ location: 'other-workspace' }),
    ]);
    expect(Object.keys(decoded.members[0]?.activities[0] ?? {}).sort()).toEqual([
      'focused', 'lastSeenAt', 'location', 'visible',
    ]);
  });
});
