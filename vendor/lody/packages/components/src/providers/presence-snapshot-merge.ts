import type { LodyPresenceStateMap } from '@lody/shared';

/**
 * Merge Electron's two presence replicas: what the local CLI pushed over the
 * local data plane, and what this renderer replicates from the cloud presence
 * room.
 *
 * The rule is per ORIGIN, not per key: for any CLI instance the local plane
 * speaks for, the local snapshot is the whole truth — including the ABSENCE of
 * an entry — so a lagging cloud replica cannot resurrect presence that instance
 * already cleared. Every other origin passes through from the cloud untouched.
 *
 * That authority is why `LocalLoroPresenceSource.encodeLocalOrigin` MUST relay
 * only entries the local CLI authored (`specs/local-first-two-plane.md`): a
 * relayed peer would be read here as local-origin.
 */
export function mergePresenceSnapshots(
  localOriginStates: LodyPresenceStateMap,
  cloudStates: LodyPresenceStateMap
): LodyPresenceStateMap {
  const localOriginInstanceIds = new Set(
    Object.values(localOriginStates).map((state) => state.instanceId)
  );
  const merged: LodyPresenceStateMap = {};

  for (const [key, state] of Object.entries(cloudStates)) {
    if (!localOriginInstanceIds.has(state.instanceId)) {
      merged[key] = state;
    }
  }

  return Object.assign(merged, localOriginStates);
}
