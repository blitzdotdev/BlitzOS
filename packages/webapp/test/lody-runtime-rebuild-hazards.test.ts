/**
 * THE TWO HAZARDS A RUNTIME REBUILD CAN TRIP, AND WHICH OF THEM IS REAL.
 *
 * `use-runtime-boot-retry.ts` rebuilds `RuntimeProvider` when its one-shot boot
 * failed and left `runtimeAtom` null. That is the fix for a freshly provisioned
 * box whose daemon is still starting — but it is also the ONLY thing in the
 * shell that rebuilds a runtime for the SAME workspace id, which puts it alone
 * against two hazards a workspace switch never meets. A switch changes
 * `workspaceId`, so it changes the IndexedDB name too; a retry does not.
 *
 * Neither hazard was settled by reading the source, and a wrong guess here is
 * silent local data loss, so both are measured against a real (fake-backed)
 * IndexedDB rather than argued about.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoroRepo, ResourceBusyError, StaleReplicaError } from "loro-repo";
import { IndexedDBStorageAdaptor } from "loro-repo/storage/indexeddb";
import {
  markCacheClearPending,
  maybeClearLodyCacheOnBoot,
  resetBootClearMemoForTests,
} from "@lody/components/lib/clear-local-cache";

const WORKSPACE_ID = "lw_rebuild_hazards";
const REPO_DB = `lody-loro-repo-db-${WORKSPACE_ID}`;
const CURSOR_DB = `lody-loro-stream-cursors-${WORKSPACE_ID}`;

/** The construction `create-workspace-runtime.ts:392` performs, with the same
 * storage adaptor and database name. */
async function openRepo(dbName: string) {
  return await LoroRepo.create({
    storageAdapter: new IndexedDBStorageAdaptor({ dbName }),
    metaDebounceCommitMs: 0,
    resolveRoomTransports: () => ({ transportIds: ["cloud"] }),
  });
}

/** Does a database exist? `indexedDB.databases()` is the only non-destructive
 * ask; an `open` would create the very thing being tested for. */
async function databaseExists(name: string): Promise<boolean> {
  const listed = await indexedDB.databases();
  return listed.some((entry) => entry.name === name);
}

async function createDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("docs");
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

async function dropDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

beforeEach(() => {
  resetBootClearMemoForTests();
  localStorage.clear();
});

afterEach(async () => {
  resetBootClearMemoForTests();
  localStorage.clear();
  await dropDatabase(REPO_DB);
  await dropDatabase(CURSOR_DB);
});

describe("hazard 1: a rebuild races the previous runtime's dispose", () => {
  /**
   * `RuntimeProvider`'s cleanup fires `void workspaceRuntime.dispose()` WITHOUT
   * awaiting it (`runtime-provider.tsx:349`), and the remounted provider reaches
   * `LoroRepo.create` in the same commit. `loro-repo` exports `ResourceBusyError`
   * and `StaleReplicaError`, so a failure mode for two live handles on one
   * database demonstrably exists — the question is whether this overlap reaches
   * it.
   */
  it("opens the same database again while the first close is still in flight", async () => {
    const first = await openRepo(REPO_DB);

    // Exactly the shape of the cleanup: started, deliberately not awaited.
    const closing = first.destroy();

    let failure: unknown = null;
    let second: Awaited<ReturnType<typeof openRepo>> | null = null;
    try {
      second = await openRepo(REPO_DB);
    } catch (cause) {
      failure = cause;
    }
    await closing;

    // Reported precisely: if this ever starts failing, the message says which of
    // the two errors it was rather than "expected null to be null".
    expect(
      failure instanceof ResourceBusyError || failure instanceof StaleReplicaError
        ? `${failure.constructor.name}: ${failure.message}`
        : failure,
    ).toBeNull();
    expect(second).not.toBeNull();

    await second?.destroy();
  });
});

describe("hazard 2: the boot cache-clear memo outlives the boot", () => {
  /**
   * `maybeClearLodyCacheOnBoot` memoizes the PROMISE, and that promise resolves
   * to the clear MODE rather than to "already ran"
   * (`clear-local-cache.ts:420-426`):
   *
   *     bootClearPromise ??= runPendingClearOnBoot();
   *     const mode = await bootClearPromise;
   *     if (!mode || extraNames.length === 0) return;
   *     await Promise.all(extraNames.map(deleteDatabaseBestEffort));
   *
   * The pending flag is removed on the first run, so the SECOND caller cannot
   * see that the clear is long finished — it reads a truthy `mode` off the memo
   * and deletes whatever databases it was handed. `RuntimeProvider` hands it the
   * current workspace's two databases on every build.
   *
   * On a normal boot this is inert, and the first two cases pin that. The third
   * is the one that matters for the retry.
   */
  it("deletes nothing at all when no clear was pending", async () => {
    await createDatabase(REPO_DB);
    await maybeClearLodyCacheOnBoot([REPO_DB, CURSOR_DB]);
    expect(await databaseExists(REPO_DB)).toBe(true);
  });

  it("deletes the workspace databases on the boot that follows a clear", async () => {
    await createDatabase(REPO_DB);
    markCacheClearPending();
    await maybeClearLodyCacheOnBoot([REPO_DB]);
    // This deletion is the feature working as intended.
    expect(await databaseExists(REPO_DB)).toBe(false);
  });

  it("says whether a LATER rebuild in the same tab deletes them again", async () => {
    markCacheClearPending();
    await maybeClearLodyCacheOnBoot([REPO_DB]);

    // The tab carries on. The workspace re-syncs and its repo is rebuilt on
    // disk — this is the state a member is in minutes after clearing the cache.
    await createDatabase(REPO_DB);
    expect(await databaseExists(REPO_DB)).toBe(true);

    // Now the daemon hiccups and `use-runtime-boot-retry` rebuilds the runtime.
    // `RuntimeProvider` calls this again with the same two database names.
    await maybeClearLodyCacheOnBoot([REPO_DB]);

    // Whatever this is, it is now written down. `false` means the retry wipes a
    // re-synced repo every time it fires, for the whole life of a tab in which
    // the member once used Settings -> Clear cache.
    expect(await databaseExists(REPO_DB)).toBe(false);
  });
});
