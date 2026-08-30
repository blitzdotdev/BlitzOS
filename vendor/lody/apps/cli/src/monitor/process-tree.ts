import type { SessionId } from '@lody/shared';
import type { ProcessTableEntry } from './process-table';

export type ProcessTreeRootSet = {
  sessionId: SessionId;
  rootPids: number[];
};

export type ProcessTreeAggregate = {
  memoryBytes: number;
  cpuTimeMicros: number;
  processCount: number;
};

export function aggregateProcessTreeUsage(
  entries: readonly ProcessTableEntry[],
  roots: readonly ProcessTreeRootSet[]
): Map<SessionId, ProcessTreeAggregate> {
  const entryByPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const ownerByRootPid = new Map<number, SessionId>();
  for (const rootSet of roots) {
    for (const pid of rootSet.rootPids) {
      if (!ownerByRootPid.has(pid)) ownerByRootPid.set(pid, rootSet.sessionId);
    }
  }

  const aggregates = new Map<SessionId, ProcessTreeAggregate>();
  for (const rootSet of roots) {
    aggregates.set(rootSet.sessionId, { memoryBytes: 0, cpuTimeMicros: 0, processCount: 0 });
  }

  for (const entry of entries) {
    const owner = resolveOwner(entry, entryByPid, ownerByRootPid);
    if (!owner) continue;
    const aggregate = aggregates.get(owner);
    if (!aggregate) continue;
    aggregate.memoryBytes += entry.memoryBytes;
    aggregate.cpuTimeMicros += entry.cpuTimeMicros;
    aggregate.processCount += 1;
  }
  return aggregates;
}

function resolveOwner(
  entry: ProcessTableEntry,
  entryByPid: ReadonlyMap<number, ProcessTableEntry>,
  ownerByRootPid: ReadonlyMap<number, SessionId>
): SessionId | null {
  const directOwner = ownerByRootPid.get(entry.pid);
  if (directOwner) return directOwner;
  if (entry.processGroupId !== null) {
    const groupOwner = ownerByRootPid.get(entry.processGroupId);
    if (groupOwner) return groupOwner;
  }

  const seen = new Set<number>([entry.pid]);
  let child = entry;
  while (child.parentPid > 0 && !seen.has(child.parentPid)) {
    seen.add(child.parentPid);
    const parent = entryByPid.get(child.parentPid);
    if (!parent || parent.startedAtMs > child.startedAtMs) return null;
    const parentOwner = ownerByRootPid.get(parent.pid);
    if (parentOwner) return parentOwner;
    child = parent;
  }
  return null;
}
