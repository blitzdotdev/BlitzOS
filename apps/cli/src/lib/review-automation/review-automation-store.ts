import {
  appendReviewRunEvent,
  getReviewPolicyFlockDocId,
  getReviewRunScanPrefix,
  getServerNow,
  parseReviewRun,
  resolveReviewPolicy,
  REVIEW_POLICY_ROW_KEY,
  reviewRunKeys,
  type ReviewPolicy,
  type ReviewRun,
  type ReviewRunState,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';

/**
 * Persistence for review policy and runs.
 *
 * Both live in one workspace-scoped Flock document. Reading and writing here
 * rather than in the scheduler keeps the scheduler a thin orchestrator, and it
 * keeps the "re-read durable state before acting" rule in one place: an engine
 * that trusted in-memory state would resume a restarted daemon into whatever it
 * last remembered rather than what actually happened.
 */

type ReviewFlockRow = { key: readonly unknown[]; value?: unknown };

type ReviewFlock = {
  scan(options?: { prefix?: readonly unknown[] }): Iterable<ReviewFlockRow>;
  set(key: readonly unknown[], value: unknown, nowMs?: number): void;
  delete(key: readonly unknown[], nowMs?: number): void;
  commit(): void;
};

type ReviewFlockHandle = {
  flock: ReviewFlock;
  syncOnce: () => Promise<unknown>;
};

const openReviewFlock = async (
  repo: LoroRepo,
  workspaceId: WorkspaceId
): Promise<ReviewFlockHandle> =>
  (await repo.openFlockDoc(getReviewPolicyFlockDocId(workspaceId))) as unknown as ReviewFlockHandle;

export const readReviewPolicy = async (
  repo: LoroRepo,
  workspaceId: WorkspaceId
): Promise<ReviewPolicy> => {
  const handle = await openReviewFlock(repo, workspaceId);
  // `scan` stays a method call: the Flock implementation reads `this`.
  for (const row of handle.flock.scan({ prefix: REVIEW_POLICY_ROW_KEY })) {
    if (row.value !== undefined) {
      return resolveReviewPolicy(row.value);
    }
  }
  return resolveReviewPolicy(undefined);
};

export const writeReviewPolicy = async (
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  policy: ReviewPolicy
): Promise<void> => {
  const handle = await openReviewFlock(repo, workspaceId);
  const now = getServerNow();
  handle.flock.set(REVIEW_POLICY_ROW_KEY, { ...policy, updatedAt: now }, now);
  handle.flock.commit();
  await repo.flush();
  await handle.syncOnce().catch(() => undefined);
};

/**
 * Pushes whatever is already committed locally.
 *
 * Needed because a submission can be durable in this machine's repo but never
 * uploaded: an MCP process that failed to sync leaves exactly that state, and a
 * retry would otherwise see "already submitted" and refuse to repair it.
 */
export const syncReviewFlockOnce = async (
  repo: LoroRepo,
  workspaceId: WorkspaceId
): Promise<void> => {
  const handle = await openReviewFlock(repo, workspaceId);
  await handle.syncOnce();
};

export const readReviewRun = async (
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  sessionId: SessionId
): Promise<ReviewRun | undefined> => {
  const handle = await openReviewFlock(repo, workspaceId);
  for (const row of handle.flock.scan({ prefix: reviewRunKeys.run(sessionId) })) {
    const parsed = parseReviewRun(row.value);
    if (parsed?.sessionId === sessionId) {
      return parsed;
    }
  }
  return undefined;
};

export const listReviewRuns = async (
  repo: LoroRepo,
  workspaceId: WorkspaceId
): Promise<ReviewRun[]> => {
  const handle = await openReviewFlock(repo, workspaceId);
  const runs: ReviewRun[] = [];
  for (const row of handle.flock.scan({ prefix: getReviewRunScanPrefix() })) {
    const parsed = parseReviewRun(row.value);
    if (parsed) {
      runs.push(parsed);
    }
  }
  return runs;
};

/**
 * Finds the run a reviewer session belongs to.
 *
 * This is the authorization for `lody_review_submit`: the tool is callable from
 * any session, so it must resolve the caller to a run that names it as the
 * reviewer. A session that is not a reviewer gets nothing to write to.
 */
export const findReviewRunByReviewerSession = async (
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  reviewerSessionId: SessionId
): Promise<ReviewRun | undefined> => {
  const runs = await listReviewRuns(repo, workspaceId);
  return runs.find((run) => run.reviewerSessionId === reviewerSessionId);
};

export const writeReviewRun = async (
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  run: ReviewRun,
  options: { confirmSync?: boolean } = {}
): Promise<void> => {
  const handle = await openReviewFlock(repo, workspaceId);
  const now = getServerNow();
  handle.flock.set(reviewRunKeys.run(run.sessionId), { ...run, updatedAt: now }, now);
  handle.flock.commit();
  await repo.flush();

  // `confirmSync` is for one-shot processes. The daemon can leave sync to its
  // own schedule because its local write IS the state the engine reads; an MCP
  // subprocess cannot — its local repo dies with the process, so a swallowed
  // sync failure would strand the submission and the engine would then block the
  // run for "finishing without submitting" after the tool reported success.
  if (options.confirmSync) {
    await handle.syncOnce();
    return;
  }
  await handle.syncOnce().catch(() => undefined);
};

export const deleteReviewRun = async (
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  sessionId: SessionId
): Promise<void> => {
  const handle = await openReviewFlock(repo, workspaceId);
  handle.flock.delete(reviewRunKeys.run(sessionId), getServerNow());
  handle.flock.commit();
  await repo.flush();
  await handle.syncOnce().catch(() => undefined);
};

/**
 * Records a state transition together with its audit line.
 *
 * Callers pass the run they just read rather than a session id so the write is
 * against state observed in the same pass; the scheduler re-reads before every
 * decision, so a lost race corrects itself on the next pass instead of
 * compounding.
 */
export const advanceReviewRun = async (
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  run: ReviewRun,
  next: {
    state: ReviewRunState;
    detail: string;
    patch?: Partial<ReviewRun>;
  }
): Promise<ReviewRun> => {
  const now = getServerNow();
  const updated: ReviewRun = {
    ...run,
    ...next.patch,
    state: next.state,
    events: appendReviewRunEvent(run.events, {
      at: now,
      state: next.state,
      detail: next.detail,
    }),
    updatedAt: now,
  };
  await writeReviewRun(repo, workspaceId, updated);
  return updated;
};
