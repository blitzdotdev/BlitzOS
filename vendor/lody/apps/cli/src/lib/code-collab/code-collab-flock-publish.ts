import {
  readCodeCollabFileIndexSignalFromFlock,
  writeCodeCollabFileIndexSignalToFlock,
  writeCodeCollabFileIndexToFlock,
  type CodeCollabFileIndexWritableFlock,
  type CodeCollabV2FileIndexState,
} from '@lody/shared';

// Publication confirmation relies on `syncOnce()` THROWING on failure: the CLI
// repo routes exactly one 'streams' transport, and loro-repo rethrows a
// single-transport failure unchanged. With ZERO transports (offline, nothing
// attached) `syncOnce()` resolves vacuously and publication is treated as
// succeeded — deliberate parity with the pre-multi-transport placeholder.
// Treating that as failure would put every offline publish into the bounded
// repair loop, which force-republishes and bumps the signal revision every
// ~30s for as long as the daemon stays deliberately offline; cloud catch-up
// after re-attach is owned by loro-repo's room rebind/resync instead.
type CodeCollabFlockHandle = {
  readonly flock: CodeCollabFileIndexWritableFlock;
  readonly syncOnce: () => Promise<unknown>;
};

export type CodeCollabFlockRepo = {
  readonly openFlockDoc: (flockDocId: string) => Promise<CodeCollabFlockHandle>;
  readonly flush: () => Promise<void>;
};

export class CodeCollabFileIndexChangedPublishError extends Error {
  constructor(cause: unknown) {
    super('Code Collab file-index publication failed after changing local Flock state.', {
      cause,
    });
    this.name = 'CodeCollabFileIndexChangedPublishError';
  }
}

export async function publishCodeCollabFileIndexFlock(args: {
  readonly repo: CodeCollabFlockRepo;
  readonly flockDocId: string;
  readonly fileIndex: CodeCollabV2FileIndexState;
  readonly updatedAtMs: number;
  readonly reconcileRemote: boolean;
}): Promise<{ readonly changed: boolean }> {
  const handle = await args.repo.openFlockDoc(args.flockDocId);
  if (args.reconcileRemote) {
    await handle.syncOnce();
  }
  const changed = writeCodeCollabFileIndexToFlock(handle.flock, args.fileIndex, args.updatedAtMs);
  if (!changed) {
    return { changed: false };
  }
  try {
    await args.repo.flush();
    await handle.syncOnce();
  } catch (error) {
    throw new CodeCollabFileIndexChangedPublishError(error);
  }
  return { changed: true };
}

export async function publishCodeCollabFileIndexSignalFlock(args: {
  readonly repo: CodeCollabFlockRepo;
  readonly flockDocId: string;
  readonly updatedAtMs: number;
}): Promise<{ readonly changed: boolean; readonly revision: number }> {
  const handle = await args.repo.openFlockDoc(args.flockDocId);
  await handle.syncOnce();
  const previous = readCodeCollabFileIndexSignalFromFlock(handle.flock);
  const revision = (previous?.r ?? 0) + 1;
  const changed = writeCodeCollabFileIndexSignalToFlock(handle.flock, revision, args.updatedAtMs);
  if (changed) {
    await args.repo.flush();
    await handle.syncOnce();
  }
  return { changed, revision };
}
