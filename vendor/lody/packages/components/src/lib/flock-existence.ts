type FlockLikeEvent = {
  key: unknown;
  value?: unknown;
};

type FlockLikeEventBatch = {
  events: FlockLikeEvent[];
};

const isMetadataObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const setNormalizedMetadataValue = (
  patch: Record<string, unknown>,
  field: string,
  value: unknown
): void => {
  patch[field] = value === undefined ? null : value;
};

export type DocExistenceState = 'active' | 'deleted' | 'missing';

export function collectDocExistenceValues(
  batch: Pick<FlockLikeEventBatch, 'events'>
): Map<string, DocExistenceState> {
  const existenceByDocId = new Map<string, DocExistenceState>();
  for (const event of batch.events) {
    const key = event.key;
    if (!Array.isArray(key) || key.length < 2) continue;
    if (key[0] !== 'e') continue;
    const docId = key[1];
    if (typeof docId !== 'string') continue;
    if (typeof event.value === 'boolean') {
      existenceByDocId.set(docId, event.value ? 'active' : 'deleted');
      continue;
    }
    if (event.value === undefined) {
      existenceByDocId.set(docId, 'missing');
    }
  }
  return existenceByDocId;
}

/**
 * Extract metadata field patches from flock events.
 *
 * Flock metadata events use the key pattern `['m', docId, fieldName]`.
 * This function collects per-docId patches by merging all field-level
 * changes within the same event batch.
 */
export function collectDocMetadataPatchesFromEntries(
  entries: Iterable<FlockLikeEvent>
): Map<string, Record<string, unknown>> {
  const patchesByDocId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const key = entry.key;
    if (!Array.isArray(key) || key.length < 2) continue;
    if (key[0] !== 'm') continue;
    const docId = key[1];
    if (typeof docId !== 'string') continue;

    if (key.length === 2) {
      if (!isMetadataObject(entry.value)) continue;
      let patch = patchesByDocId.get(docId);
      if (!patch) {
        patch = {};
        patchesByDocId.set(docId, patch);
      }
      for (const [field, value] of Object.entries(entry.value)) {
        setNormalizedMetadataValue(patch, field, value);
      }
      continue;
    }

    const field = key[2];
    if (typeof field !== 'string') continue;
    let patch = patchesByDocId.get(docId);
    if (!patch) {
      patch = {};
      patchesByDocId.set(docId, patch);
    }
    // Normalize undefined → null to match loro-repo's canonical patch shape
    // (FlockHydrator maps `undefined` to `null` in MetadataManager.reconcileDoc)
    setNormalizedMetadataValue(patch, field, entry.value);
  }
  return patchesByDocId;
}

export function collectDocMetadataPatches(
  batch: Pick<FlockLikeEventBatch, 'events'>
): Map<string, Record<string, unknown>> {
  return collectDocMetadataPatchesFromEntries(batch.events);
}
