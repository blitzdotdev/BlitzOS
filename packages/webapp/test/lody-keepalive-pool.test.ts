import { describe, expect, it } from "vitest";
import {
  LODY_KEEPALIVE_STORAGE_KEY,
  LODY_SURFACE_POOL_CAPACITY,
  activateLodySurface,
  createLodyKeepalivePool,
  deactivateLodySurface,
  discontinueLodySurface,
  disposeLodyKeepalivePool,
  lodyKeepaliveEnabled,
  reportLodySurfaceIdentity,
  requestLodySurface,
  type LodyKeepalivePool,
  type LodyPoolDecision,
  type LodySurfaceIdentity,
  type LodySurfaceKind,
} from "../src/lody/keepalive-pool.js";

const A = { machineId: "machine-a", lwWorkspaceId: "lw_a" } satisfies LodySurfaceIdentity;
const B = { machineId: "machine-b", lwWorkspaceId: "lw_b" } satisfies LodySurfaceIdentity;
const C = { machineId: "machine-c", lwWorkspaceId: "lw_c" } satisfies LodySurfaceIdentity;

function enter(
  pool: LodyKeepalivePool,
  endpointFingerprint: string,
  kind: LodySurfaceKind = "owned",
): LodyPoolDecision {
  const requested = requestLodySurface(pool, { endpointFingerprint, kind });
  if (requested.entryId === null) throw new Error("surface request selected no entry");
  const activated = activateLodySurface(requested.pool, requested.entryId);
  return {
    ...activated,
    mount: requested.mount,
    dispose: [...requested.dispose, ...activated.dispose],
  };
}

function identify(
  pool: LodyKeepalivePool,
  entryId: string,
  identity: LodySurfaceIdentity,
): LodyKeepalivePool {
  return reportLodySurfaceIdentity(pool, entryId, identity).pool;
}

function selectedId(decision: LodyPoolDecision): string {
  if (decision.entryId === null) throw new Error("pool decision selected no entry");
  return decision.entryId;
}

describe("the Lody keep-alive pool", () => {
  it("reuses only an identity-known continuous hidden entry", () => {
    let pool = createLodyKeepalivePool();
    const first = enter(pool, "endpoint-a");
    const aId = first.entryId;
    if (aId === null) throw new Error("A did not mount");
    pool = identify(first.pool, aId, A);

    const second = enter(pool, "endpoint-b");
    const bId = second.entryId;
    if (bId === null) throw new Error("B did not mount");
    pool = identify(second.pool, bId, B);
    const returnToA = requestLodySurface(pool, {
      endpointFingerprint: "endpoint-a",
      kind: "owned",
    });

    expect(returnToA.entryId).toBe(aId);
    expect(returnToA.mount).toEqual([]);
    expect(returnToA.reused).toBe(true);
    const activated = activateLodySurface(returnToA.pool, aId);
    expect(activated.validate).toEqual([aId]);
    expect(activated.hide).toEqual([bId]);
  });

  it("never reuses a provisional entry after it is hidden", () => {
    let pool = createLodyKeepalivePool();
    const first = enter(pool, "endpoint-a");
    const provisionalId = first.entryId;
    if (provisionalId === null) throw new Error("provisional surface did not mount");

    // A request that leaves before its snapshot settles disposes the
    // provisional surface instead of making an identity-less cache entry.
    const second = enter(first.pool, "endpoint-b");
    expect(second.dispose).toContain(provisionalId);
    pool = second.pool;

    const returnToA = enter(pool, "endpoint-a");
    expect(returnToA.entryId).not.toBe(provisionalId);
    expect(returnToA.mount).toEqual([returnToA.entryId]);
  });

  it("rekeys a provisional entry and suppresses a duplicate identity", () => {
    let pool = createLodyKeepalivePool(3);
    const first = enter(pool, "old-endpoint");
    const oldId = first.entryId;
    if (oldId === null) throw new Error("old surface did not mount");
    pool = identify(first.pool, oldId, A);

    const second = enter(pool, "new-endpoint");
    const newId = second.entryId;
    if (newId === null) throw new Error("new surface did not mount");
    const duplicate = reportLodySurfaceIdentity(second.pool, newId, A);

    // The reporting surface is active, so it wins and the stale hidden copy is
    // released before either endpoint can be reused again.
    expect(duplicate.dispose).toEqual([oldId]);
    expect(duplicate.pool.entries).toHaveLength(1);
    expect(duplicate.pool.entries[0]?.entryId).toBe(newId);
    expect(duplicate.pool.entries[0]?.key).toEqual(A);
  });

  it("evicts the least-recent hidden entry over capacity and never the active one", () => {
    let pool = createLodyKeepalivePool(LODY_SURFACE_POOL_CAPACITY);
    const first = enter(pool, "endpoint-a");
    const aId = selectedId(first);
    pool = identify(first.pool, aId, A);
    const second = enter(pool, "endpoint-b");
    const bId = selectedId(second);
    pool = identify(second.pool, bId, B);

    const third = enter(pool, "endpoint-c");
    const cId = selectedId(third);
    pool = identify(third.pool, cId, C);

    expect(third.dispose).toEqual([aId]);
    expect(third.dispose).not.toContain(bId);
    expect(third.dispose).not.toContain(cId);
    expect(pool.activeEntryId).toBe(cId);
    expect(pool.entries.map((entry) => entry.entryId)).toEqual([bId, cId]);
  });

  it("treats a shared surface as transient beside only the newest owned surface", () => {
    let pool = createLodyKeepalivePool(3);
    const first = enter(pool, "owned-a");
    const aId = selectedId(first);
    pool = identify(first.pool, aId, A);
    const second = enter(pool, "owned-b");
    const bId = selectedId(second);
    pool = identify(second.pool, bId, B);

    const shared = enter(pool, "shared-c", "shared");
    const sharedId = selectedId(shared);
    expect(shared.dispose).toContain(aId);
    expect(shared.pool.entries.map((entry) => entry.entryId)).toEqual([bId, sharedId]);

    const backToOwned = enter(shared.pool, "owned-b");
    expect(backToOwned.entryId).toBe(bId);
    expect(backToOwned.dispose).toContain(sharedId);
    expect(backToOwned.pool.entries.map((entry) => entry.entryId)).toEqual([bId]);
  });

  it("evicts a discontinuous hidden entry and revalidates an active one", () => {
    let pool = createLodyKeepalivePool();
    const first = enter(pool, "endpoint-a");
    const aId = selectedId(first);
    pool = identify(first.pool, aId, A);
    const second = enter(pool, "endpoint-b");
    const bId = selectedId(second);
    pool = identify(second.pool, bId, B);

    const hiddenLoss = discontinueLodySurface(pool, aId);
    expect(hiddenLoss.dispose).toEqual([aId]);
    expect(hiddenLoss.pool.entries.some((entry) => entry.entryId === aId)).toBe(false);

    const activeLoss = discontinueLodySurface(hiddenLoss.pool, bId);
    expect(activeLoss.dispose).toEqual([]);
    expect(activeLoss.validate).toEqual([bId]);
    expect(activeLoss.pool.entries.find((entry) => entry.entryId === bId)?.continuous).toBe(false);

    const revalidated = reportLodySurfaceIdentity(activeLoss.pool, bId, B);
    expect(revalidated.pool.entries[0]?.continuous).toBe(true);
  });

  it("hides a known owned surface while no capability target is available", () => {
    const mounted = enter(createLodyKeepalivePool(), "endpoint-a");
    const entryId = selectedId(mounted);
    const pool = identify(mounted.pool, entryId, A);
    const hidden = deactivateLodySurface(pool);
    expect(hidden.hide).toEqual([entryId]);
    expect(hidden.pool.activeEntryId).toBeNull();
    expect(hidden.pool.entries[0]?.state).toBe("hidden");
  });

  it("invalidates an active entry whose validation reports a changed identity", () => {
    const mounted = enter(createLodyKeepalivePool(), "endpoint-a");
    const entryId = selectedId(mounted);
    const known = identify(mounted.pool, entryId, A);
    const mismatch = reportLodySurfaceIdentity(known, entryId, B);

    expect(mismatch.dispose).toEqual([entryId]);
    expect(mismatch.pool.activeEntryId).toBeNull();
    expect(mismatch.pool.entries).toEqual([]);
  });

  it("disposes every entry on region teardown", () => {
    const first = enter(createLodyKeepalivePool(), "endpoint-a");
    const entryId = selectedId(first);
    const pool = identify(first.pool, entryId, A);
    const disposed = disposeLodyKeepalivePool(pool);
    expect(disposed.dispose).toEqual([entryId]);
    expect(disposed.pool.entries).toEqual([]);
  });
});

describe("the runtime keep-alive kill switch", () => {
  it("defaults on and only the exact off value disables retention", () => {
    expect(lodyKeepaliveEnabled(null)).toBe(true);
    expect(lodyKeepaliveEnabled({ getItem: () => null })).toBe(true);
    expect(lodyKeepaliveEnabled({ getItem: () => "OFF" })).toBe(true);
    expect(lodyKeepaliveEnabled({
      getItem: (key) => key === LODY_KEEPALIVE_STORAGE_KEY ? "off" : null,
    })).toBe(false);
  });

  it("fails open when storage access is unavailable", () => {
    expect(lodyKeepaliveEnabled({
      getItem: () => {
        throw new Error("storage denied");
      },
    })).toBe(true);
  });
});
