import type { PrStatus, SessionPullRequestMeta } from '@lody/shared';
import { getSessionPullRequestLegacyFields } from '@lody/shared';

export type AutoArchivePrSnapshot = {
  url: string;
  status: PrStatus | null;
};

export type AutoArchivePrDecision = {
  shouldArchive: boolean;
  status: PrStatus | null;
};

export function pickLatestPr(
  prs: SessionPullRequestMeta[] | undefined
): SessionPullRequestMeta | null {
  if (!prs || prs.length === 0) return null;
  let latest = prs[0];
  if (!latest) return null;
  for (let i = 1; i < prs.length; i++) {
    const candidate = prs[i];
    if (!candidate) continue;
    // ISO 8601 timestamps sort lexicographically, so plain `>` is correct and cheaper.
    const candidateReportedAt = getSessionPullRequestLegacyFields(candidate).reportedAt;
    const latestReportedAt = getSessionPullRequestLegacyFields(latest).reportedAt;
    if (candidateReportedAt || latestReportedAt) {
      if ((candidateReportedAt ?? '') > (latestReportedAt ?? '')) {
        latest = candidate;
      }
      continue;
    }
    if (i > 0) {
      latest = candidate;
    }
  }
  return latest;
}

export function getAutoArchivePrSnapshot(
  prs: SessionPullRequestMeta[] | undefined
): AutoArchivePrSnapshot | null {
  const latest = pickLatestPr(prs);
  if (!latest) return null;
  return {
    url: latest.url,
    status: latest.status ?? null,
  };
}

export function getAutoArchivePrDecision(args: {
  previous: AutoArchivePrSnapshot | undefined;
  current: AutoArchivePrSnapshot | null;
  archiveOnMerged: boolean;
  archiveOnClosed: boolean;
}): AutoArchivePrDecision {
  const status = args.current?.status ?? null;
  if (!args.current || (status !== 'merged' && status !== 'closed')) {
    return { shouldArchive: false, status };
  }

  if (status === 'merged' && !args.archiveOnMerged) {
    return { shouldArchive: false, status };
  }
  if (status === 'closed' && !args.archiveOnClosed) {
    return { shouldArchive: false, status };
  }

  const previous = args.previous;
  if (!previous || previous.url !== args.current.url || previous.status === status) {
    return { shouldArchive: false, status };
  }

  return { shouldArchive: true, status };
}
