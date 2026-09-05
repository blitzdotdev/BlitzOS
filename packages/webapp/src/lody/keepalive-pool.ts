/** Pure state machine for the identity-keyed Lody surface keep-alive pool. */

export const LODY_SURFACE_POOL_CAPACITY = 2;
export const LODY_SURFACE_POOL_MIN_DEVICE_MEMORY_GIB = 4;
export const LODY_KEEPALIVE_STORAGE_KEY = "blitz.lody.keepalive";

export interface LodySurfaceIdentity {
  machineId: string;
  lwWorkspaceId: string;
}

export function lodySurfaceIdentityKey(identity: LodySurfaceIdentity): string {
  return JSON.stringify([identity.machineId, identity.lwWorkspaceId]);
}

export type LodySurfaceKind = "owned" | "shared";
export type LodySurfaceState = "booting" | "ready";

export interface LodyKeepaliveEntry {
  entryId: string;
  key: LodySurfaceIdentity | null;
  /** A URL-derived lookup hint. It is never authoritative identity. */
  endpointFingerprint: string;
  kind: LodySurfaceKind;
  state: LodySurfaceState;
  /** Bumped whenever a live surface needs a fresh platform identity check. */
  generation: number;
  lastUsed: number;
  continuous: boolean;
}

export interface LodyKeepalivePool {
  entries: readonly LodyKeepaliveEntry[];
  activeEntryId: string | null;
  capacity: number;
  clock: number;
  nextEntrySequence: number;
}

export interface LodySurfaceTarget {
  endpointFingerprint: string;
  kind: LodySurfaceKind;
}

export interface LodyPoolDecision {
  pool: LodyKeepalivePool;
  /** Entry selected by a request/activation, if that operation selects one. */
  entryId: string | null;
}

export interface LodyPoolSelection extends LodyPoolDecision {
  entryId: string;
}

interface KeepaliveStorage {
  getItem(key: string): string | null;
}

export interface LodySurfaceDevicePolicy {
  deviceMemory: number | undefined;
  desktopClass: boolean;
}

function emptyDecision(pool: LodyKeepalivePool, entryId: string | null): LodyPoolDecision {
  return { pool, entryId };
}

function nextClock(pool: LodyKeepalivePool): number {
  return pool.clock + 1;
}

function newest(entries: readonly LodyKeepaliveEntry[]): LodyKeepaliveEntry | undefined {
  return [...entries].sort((left, right) => right.lastUsed - left.lastUsed)[0];
}

function withoutEntries(
  pool: LodyKeepalivePool,
  disposed: ReadonlySet<string>,
): LodyKeepalivePool {
  if (disposed.size === 0) return pool;
  if (pool.activeEntryId !== null && disposed.has(pool.activeEntryId)) {
    throw new Error("lody_keepalive_removed_active_entry");
  }
  return {
    ...pool,
    entries: pool.entries.filter((entry) => !disposed.has(entry.entryId)),
  };
}

function entryFor(pool: LodyKeepalivePool, entryId: string): LodyKeepaliveEntry {
  const entry = pool.entries.find((candidate) => candidate.entryId === entryId);
  if (entry === undefined) throw new Error("lody_keepalive_entry_missing");
  return entry;
}

function activeEntry(pool: LodyKeepalivePool): LodyKeepaliveEntry | null {
  return pool.activeEntryId === null ? null : entryFor(pool, pool.activeEntryId);
}

export function createLodyKeepalivePool(
  capacity = LODY_SURFACE_POOL_CAPACITY,
): LodyKeepalivePool {
  return { entries: [], activeEntryId: null, capacity, clock: 0, nextEntrySequence: 1 };
}

/** Retain a neighbor only with sufficient reported memory or a known desktop shell. */
export function lodySurfacePoolCapacity(policy: LodySurfaceDevicePolicy): number {
  return policy.deviceMemory !== undefined
    ? policy.deviceMemory >= LODY_SURFACE_POOL_MIN_DEVICE_MEMORY_GIB
      ? LODY_SURFACE_POOL_CAPACITY
      : 1
    : policy.desktopClass
    ? LODY_SURFACE_POOL_CAPACITY
    : 1;
}

/** Apply a runtime policy change, evicting oldest non-active entries immediately. */
export function resizeLodyKeepalivePool(
  pool: LodyKeepalivePool,
  capacity: number,
): LodyPoolDecision {
  const disposed = new Set([...pool.entries]
    .filter((entry) => entry.entryId !== pool.activeEntryId)
    .sort((left, right) => left.lastUsed - right.lastUsed)
    .slice(0, Math.max(0, pool.entries.length - capacity))
    .map((entry) => entry.entryId));
  const next = withoutEntries({ ...pool, capacity }, disposed);
  return emptyDecision(next, next.activeEntryId);
}

/**
 * Select a continuous, identity-known hidden entry by endpoint hint, or create
 * a provisional entry. A provisional entry is never reused after it is hidden.
 */
export function requestLodySurface(
  pool: LodyKeepalivePool,
  target: LodySurfaceTarget,
): LodyPoolSelection {
  const active = activeEntry(pool);
  if (
    active !== null
    && active.endpointFingerprint === target.endpointFingerprint
    && active.kind === target.kind
  ) {
    return { pool, entryId: active.entryId };
  }

  const candidate = newest(
    pool.entries.filter(
      (entry) =>
        entry.entryId !== pool.activeEntryId
        && entry.state === "ready"
        && entry.key !== null
        && entry.continuous
        && entry.endpointFingerprint === target.endpointFingerprint
        && entry.kind === target.kind,
    ),
  );
  if (candidate !== undefined) {
    return { pool, entryId: candidate.entryId };
  }

  const clock = nextClock(pool);
  const entryId = `lody-surface-${pool.nextEntrySequence}`;
  const entry: LodyKeepaliveEntry = {
    entryId,
    key: null,
    endpointFingerprint: target.endpointFingerprint,
    kind: target.kind,
    state: "booting",
    generation: 0,
    lastUsed: clock,
    continuous: true,
  };
  return {
    pool: {
      ...pool,
      entries: [...pool.entries, entry],
      clock,
      nextEntrySequence: pool.nextEntrySequence + 1,
    },
    entryId,
  };
}

/** Activate one requested entry, then enforce transient-sharing and LRU rules. */
export function activateLodySurface(
  pool: LodyKeepalivePool,
  entryId: string,
): LodyPoolSelection {
  const selected = entryFor(pool, entryId);
  if (pool.activeEntryId === entryId) return { pool, entryId };

  const clock = nextClock(pool);
  const dispose = new Set<string>();
  const selectedWasRetained = selected.key !== null;

  let entries = pool.entries.map((entry): LodyKeepaliveEntry => {
    if (entry.entryId === entryId) {
      return {
        ...entry,
        generation: selectedWasRetained ? entry.generation + 1 : entry.generation,
        lastUsed: clock,
      };
    }
    if (entry.entryId !== pool.activeEntryId) return entry;
    // Shared and provisional entries are transient. They cannot become a
    // reusable hidden cache entry, so release them at the hand-off.
    if (entry.kind === "shared" || entry.key === null || !entry.continuous) {
      dispose.add(entry.entryId);
    }
    return entry;
  });

  if (selected.kind === "owned") {
    for (const entry of entries) {
      if (entry.entryId !== entryId && entry.kind === "shared") dispose.add(entry.entryId);
    }
  } else {
    // One active shared surface may coexist only with the most recent owned
    // surface. A second shared surface and older owned entries are discarded.
    for (const entry of entries) {
      if (entry.entryId !== entryId && entry.kind === "shared") dispose.add(entry.entryId);
    }
    const ownedToKeep = newest(
      entries.filter((entry) => entry.kind === "owned" && !dispose.has(entry.entryId)),
    );
    for (const entry of entries) {
      if (
        entry.kind === "owned"
        && entry.entryId !== ownedToKeep?.entryId
        && entry.entryId !== entryId
      ) {
        dispose.add(entry.entryId);
      }
    }
  }

  entries = entries.filter((entry) => !dispose.has(entry.entryId));
  while (entries.length > pool.capacity) {
    const victim = [...entries]
      .filter((entry) => entry.entryId !== entryId)
      .sort((left, right) => left.lastUsed - right.lastUsed)[0];
    if (victim === undefined) throw new Error("lody_keepalive_capacity_without_victim");
    dispose.add(victim.entryId);
    entries = entries.filter((entry) => entry.entryId !== victim.entryId);
  }

  const nextPool: LodyKeepalivePool = {
    ...pool,
    entries,
    activeEntryId: entryId,
    clock,
  };
  return { pool: nextPool, entryId };
}

/** Hide the current owned entry while the shell has no eligible surface target. */
export function deactivateLodySurface(pool: LodyKeepalivePool): LodyPoolDecision {
  if (pool.activeEntryId === null) return emptyDecision(pool, null);
  const active = entryFor(pool, pool.activeEntryId);
  if (active.kind === "shared" || active.key === null || !active.continuous) {
    return emptyDecision(
      withoutEntries({ ...pool, activeEntryId: null }, new Set([active.entryId])),
      null,
    );
  }
  return emptyDecision({ ...pool, activeEntryId: null }, null);
}

/** Rekey a provisional entry, suppressing every duplicate daemon identity. */
export function reportLodySurfaceIdentity(
  pool: LodyKeepalivePool,
  entryId: string,
  key: LodySurfaceIdentity,
): LodyPoolDecision {
  const reporting = pool.entries.find((entry) => entry.entryId === entryId);
  if (reporting === undefined) return emptyDecision(pool, null);

  if (reporting.key !== null && lodySurfaceIdentityKey(reporting.key) !== lodySurfaceIdentityKey(key)) {
    const deactivated = {
      ...pool,
      activeEntryId: pool.activeEntryId === entryId ? null : pool.activeEntryId,
    };
    return emptyDecision(withoutEntries(deactivated, new Set([entryId])), null);
  }

  const duplicates = pool.entries.filter(
    (entry) => entry.entryId !== entryId
      && entry.key !== null
      && lodySurfaceIdentityKey(entry.key) === lodySurfaceIdentityKey(key),
  );
  const contenders = [reporting, ...duplicates];
  const activeContender = contenders.find((entry) => entry.entryId === pool.activeEntryId);
  // An already-known continuous identity wins over a provisional endpoint.
  // Its runtime is the only one permitted to exist; the provisional surface
  // is removed before RuntimeProvider receives a claim.
  const retained = reporting.key === null
    ? newest(duplicates.filter((entry) => entry.continuous))
    : undefined;
  const survivor = retained ?? activeContender ?? newest(contenders) ?? reporting;
  const disposed = new Set(
    contenders.filter((entry) => entry.entryId !== survivor.entryId).map((entry) => entry.entryId),
  );

  const replacingActive = disposed.has(pool.activeEntryId ?? "");
  let nextPool = withoutEntries(
    replacingActive ? { ...pool, activeEntryId: null } : pool,
    disposed,
  );
  nextPool = {
    ...nextPool,
    entries: nextPool.entries.map((entry): LodyKeepaliveEntry => {
      if (entry.entryId !== survivor.entryId) return entry;
      return {
        ...entry,
        key,
        continuous: true,
        state: "ready",
      };
    }),
  };
  if (survivor.entryId !== entryId && replacingActive) {
    return { ...activateLodySurface(nextPool, survivor.entryId), entryId: null };
  }
  return emptyDecision(nextPool, disposed.has(entryId) ? null : survivor.entryId);
}

/**
 * A hidden discontinuous entry is unrecoverable. An active one remains visible
 * only long enough to complete a fresh identity validation.
 */
export function discontinueLodySurface(
  pool: LodyKeepalivePool,
  entryId: string,
): LodyPoolDecision {
  const entry = pool.entries.find((item) => item.entryId === entryId);
  if (entry === undefined) return emptyDecision(pool, null);
  if (pool.activeEntryId !== entryId) {
    return emptyDecision(withoutEntries(pool, new Set([entryId])), null);
  }

  const nextPool: LodyKeepalivePool = {
    ...pool,
    entries: pool.entries.map((item) =>
      item.entryId === entryId
        ? { ...item, continuous: false, generation: item.generation + 1 }
        : item),
  };
  return emptyDecision(nextPool, entryId);
}

/** Runtime switch: absent or inaccessible storage means retention stays on. */
export function lodyKeepaliveEnabled(storage?: KeepaliveStorage | null): boolean {
  try {
    const source = storage === undefined ? globalThis.localStorage : storage;
    return source?.getItem(LODY_KEEPALIVE_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}
