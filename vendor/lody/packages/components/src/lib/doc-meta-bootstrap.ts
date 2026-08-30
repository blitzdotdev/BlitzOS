import type { DocExistenceState } from './flock-existence';
import { withDerivedDocMetaId } from './doc-meta-room';

type MetaCacheEntry = Record<string, unknown>;

export function mergeBootstrapMetaCache<T extends MetaCacheEntry>(
  snapshot: Record<string, T>,
  live: Record<string, T>,
  existenceOverrides?: ReadonlyMap<string, DocExistenceState>
): Record<string, T> {
  const merged: Record<string, T> = { ...snapshot };

  for (const [docId, liveMeta] of Object.entries(live)) {
    const snapshotMeta = merged[docId];
    const candidate = withDerivedDocMetaId(
      docId,
      snapshotMeta ? ({ ...snapshotMeta, ...liveMeta } as T) : ({ ...liveMeta } as T)
    );
    merged[docId] = candidate;
  }

  if (!existenceOverrides) {
    return merged;
  }

  for (const [docId, state] of existenceOverrides) {
    if (state === 'deleted') {
      delete merged[docId];
    }
  }

  return merged;
}
