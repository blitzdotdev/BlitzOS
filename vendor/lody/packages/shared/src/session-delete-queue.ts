import type { MachineLegacyMetaFields, NeedToDeleteSessionQueueItem, SessionMeta } from './schema';

export type NeedToDeleteSessionQueueRecord = Exclude<NeedToDeleteSessionQueueItem, boolean>;

const nonEmptyString = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

export function buildNeedToDeleteSessionQueueItem(options: {
  session: Pick<
    SessionMeta,
    'project' | 'repoFullName' | 'branchName' | 'baseBranch' | 'isWorktree'
  >;
  machineMeta?: Pick<MachineLegacyMetaFields, 'localProjects'>;
  requestedAt: number;
}): NeedToDeleteSessionQueueRecord {
  const { session, machineMeta, requestedAt } = options;
  const localProjectId =
    session.project?.kind === 'local' ? session.project.localProjectId : undefined;
  const originalRootPath =
    localProjectId !== undefined
      ? machineMeta?.localProjects?.[localProjectId]?.rootPath
      : undefined;
  const repoFullName =
    session.project?.kind !== 'local' ? nonEmptyString(session.repoFullName) : undefined;
  const branchName = nonEmptyString(session.branchName);
  const baseBranchName = nonEmptyString(session.baseBranch);

  return {
    ...(repoFullName !== undefined ? { repoFullName } : {}),
    ...(branchName !== undefined ? { branchName } : {}),
    ...(baseBranchName !== undefined ? { baseBranchName } : {}),
    ...(session.isWorktree === true ? { isWorktree: true } : {}),
    ...(localProjectId !== undefined ? { localProjectId } : {}),
    ...(originalRootPath !== undefined && originalRootPath.length > 0 ? { originalRootPath } : {}),
    requestedAt,
  };
}

export function mergeNeedToDeleteSessionQueueItem(
  existing: NeedToDeleteSessionQueueItem | undefined,
  next: NeedToDeleteSessionQueueRecord
): NeedToDeleteSessionQueueRecord {
  if (existing === undefined || typeof existing !== 'object' || existing === null) {
    return next;
  }
  const { keptWorktreePath: _keptWorktreePath, ...existingRequest } = existing;
  return {
    ...existingRequest,
    ...next,
  };
}
