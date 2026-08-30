import type { LoroDocumentManager } from './doc';

type RepoExistenceManager = Pick<LoroDocumentManager, 'repo'>;

export async function listAliveRoomIds(
  manager: RepoExistenceManager,
  predicate: (roomId: string) => boolean
): Promise<string[]> {
  const scanner = manager.repo.getMeta();
  if (!scanner) {
    return [];
  }

  const ids = new Set<string>();
  // `e/<docId>` is loro-repo's authoritative existence index. Reading it also
  // avoids materializing every application metadata value under `m/<docId>/*`.
  const rows = await scanner.scan({ prefix: ['e'], includeRaw: false });
  for (const row of rows) {
    const key = row.key;
    if (!Array.isArray(key) || key.length < 2) {
      continue;
    }
    const roomId = key[1];
    if (row.value !== true || typeof roomId !== 'string' || !predicate(roomId)) {
      continue;
    }
    ids.add(roomId);
  }

  return Array.from(ids);
}
