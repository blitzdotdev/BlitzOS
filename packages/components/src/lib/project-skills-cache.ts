import { KNOWN_SKILL_DIRS_VERSION, type ProjectSkillGroup } from '@lody/shared';

export type ProjectSkillsCacheSource = 'local' | 'github' | 'global';

export type ProjectSkillsCacheEntry = {
  key: string;
  groups: ProjectSkillGroup[];
  source: ProjectSkillsCacheSource;
  commitSha?: string;
  contentFingerprint?: string;
  knownDirsVersion: number;
  fetchedAt: number;
};

const DB_NAME = 'lody:project-skills';
const DB_VERSION = 1;
const STORE_NAME = 'skillsByKey';

const memoryCache = new Map<string, ProjectSkillsCacheEntry>();

function cacheKeyPart(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Project skills cache key requires ${label}.`);
  }
  return encodeURIComponent(normalized);
}

export function getLocalProjectSkillsCacheKey(
  userId: string,
  workspaceId: string,
  machineId: string,
  localProjectId: string
): string {
  return [
    'user',
    cacheKeyPart(userId, 'userId'),
    'workspace',
    cacheKeyPart(workspaceId, 'workspaceId'),
    'local',
    cacheKeyPart(machineId, 'machineId'),
    cacheKeyPart(localProjectId, 'localProjectId'),
  ].join(':');
}

export function getGitHubProjectSkillsCacheKey(
  userId: string,
  workspaceId: string,
  repoFullName: string
): string {
  return [
    'user',
    cacheKeyPart(userId, 'userId'),
    'workspace',
    cacheKeyPart(workspaceId, 'workspaceId'),
    'github',
    cacheKeyPart(repoFullName.toLowerCase(), 'repoFullName'),
  ].join(':');
}

/**
 * Machine-global skills are keyed by `(user, workspace, machine)`: independent
 * of any project/repo, but still scoped to the current Lody auth principal.
 * Used so a GitHub or plain-agent chat can surface the running machine's global
 * skills without re-scanning per project.
 */
export function getMachineGlobalSkillsCacheKey(
  userId: string,
  workspaceId: string,
  machineId: string
): string {
  return [
    'user',
    cacheKeyPart(userId, 'userId'),
    'workspace',
    cacheKeyPart(workspaceId, 'workspaceId'),
    'global',
    cacheKeyPart(machineId, 'machineId'),
  ].join(':');
}

function isCurrentCacheEntry(entry: ProjectSkillsCacheEntry): boolean {
  return entry.knownDirsVersion === KNOWN_SKILL_DIRS_VERSION;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export async function readProjectSkillsCacheEntry(
  key: string
): Promise<ProjectSkillsCacheEntry | null> {
  const cached = memoryCache.get(key);
  if (cached) {
    return isCurrentCacheEntry(cached) ? cached : null;
  }

  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const result = (req.result as ProjectSkillsCacheEntry | undefined) ?? null;
        if (!result || !isCurrentCacheEntry(result)) {
          resolve(null);
          return;
        }
        memoryCache.set(key, result);
        resolve(result);
      };
    });
  } catch {
    return null;
  }
}

export async function writeProjectSkillsCacheEntry(entry: ProjectSkillsCacheEntry): Promise<void> {
  memoryCache.set(entry.key, entry);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(entry, entry.key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  } catch {
    // The in-memory cache still preserves the SWR behavior for this tab.
  }
}
