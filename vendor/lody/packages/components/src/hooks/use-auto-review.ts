import { useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_REVIEW_POLICY,
  getReviewPolicyFlockDocId,
  getServerNow,
  getSessionRoomId,
  isMachineReviewerConfigUsable,
  isLoroRepoDocDeleted,
  type MachineReviewerConfig,
  type ReviewPolicy,
  type ReviewRun,
  type ReviewRunId,
  type ReviewRunMode,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import {
  deleteReviewRunFromFlock,
  readMachineReviewerConfigFromFlock,
  readReviewPolicyFromFlock,
  readReviewRunFromFlock,
  writeReviewRunToFlock,
} from '@/atoms/review-policy';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';

export type AutoReviewStartResult = 'started' | 'configuration_required' | 'unavailable';

/**
 * Owns turning auto review on and off for one session, and reading its run.
 *
 * Enabling writes two things that have to agree: the durable authorization on
 * session metadata, and the run holding a frozen copy of the policy. The run is
 * written FIRST — the machine reacts to the authorization, so publishing that
 * before the run exists would race the engine into reading a run that is not
 * there yet.
 */
export function useAutoReview(sessionId: SessionId | undefined, meta: SessionMeta | undefined) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const allAgentConfigs = useAtomValue(getAllAgentConfigAtom);
  const [run, setRun] = useState<ReviewRun | undefined>(undefined);
  const [policy, setPolicy] = useState<ReviewPolicy>(DEFAULT_REVIEW_POLICY);
  const [reviewerConfig, setReviewerConfig] = useState<MachineReviewerConfig | null | undefined>(
    undefined
  );

  const autoReview = meta?.autoReview;
  const runId = autoReview?.runId;
  const machineId = meta?.machineId;
  const machineIds = useMemo(() => (machineId ? [machineId] : []), [machineId]);
  useMachineFlockAgentConfigsForMachineIds(machineIds);

  useEffect(() => {
    if (!runtime) {
      setReviewerConfig(null);
      setRun(undefined);
      return undefined;
    }
    // Do not let the previous workspace/session look configured while the new
    // Flock rows are still loading. `start` re-checks durably either way, but
    // the action surface should reflect that uncertainty too.
    setReviewerConfig(undefined);
    setRun(undefined);
    let cancelled = false;
    let unsubscribeFlock: (() => void) | null = null;
    let unsubscribeRoom: (() => void) | null = null;

    const load = async () => {
      const [loadedPolicy, loadedReviewer, loadedRun] = await Promise.all([
        readReviewPolicyFromFlock(runtime),
        machineId
          ? readMachineReviewerConfigFromFlock(runtime, machineId)
          : Promise.resolve(undefined),
        sessionId && runId
          ? readReviewRunFromFlock(runtime, sessionId)
          : Promise.resolve(undefined),
      ]);
      if (cancelled) {
        return;
      }
      setPolicy(loadedPolicy);
      setReviewerConfig(loadedReviewer ?? null);
      setRun(loadedRun);
    };

    void (async () => {
      try {
        const handle = await runtime.repo.openFlockDoc(
          getReviewPolicyFlockDocId(runtime.workspaceId)
        );
        if (cancelled) {
          return;
        }
        await load();
        // Policy, machine reviewer config, and run transitions share this
        // document. Joining the room is what makes remote settings edits and
        // machine-authored run states reach this device.
        unsubscribeFlock = handle.flock.subscribe(() => {
          void load();
        });
        const subscription = await handle.joinRoom();
        if (cancelled) {
          subscription.unsubscribe();
          return;
        }
        unsubscribeRoom = () => subscription.unsubscribe();
        await subscription.firstSyncedWithRemote;
        if (!cancelled) {
          // Re-read rather than trusting the event stream: first remote sync can
          // land as a snapshot rather than per-row events.
          await load();
        }
      } catch {
        if (!cancelled) {
          setReviewerConfig(null);
          setRun(undefined);
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribeFlock?.();
      unsubscribeRoom?.();
    };
  }, [machineId, runtime, sessionId, runId]);

  const reviewerConfigurationReady = isMachineReviewerConfigUsable(
    reviewerConfig,
    machineId,
    allAgentConfigs
  );

  const start = useCallback(
    async (mode: ReviewRunMode): Promise<AutoReviewStartResult> => {
      if (!runtime || !sessionId) {
        return 'unavailable';
      }
      const roomId = getSessionRoomId(sessionId);
      const existing = await runtime.repo.getDocMeta(roomId);
      if (isLoroRepoDocDeleted(existing)) {
        return 'unavailable';
      }
      const currentMeta = existing?.meta as SessionMeta | undefined;
      if (!currentMeta?.machineId) {
        return 'configuration_required';
      }
      const machineReviewer = await readMachineReviewerConfigFromFlock(
        runtime,
        currentMeta.machineId
      );
      if (!isMachineReviewerConfigUsable(machineReviewer, currentMeta.machineId, allAgentConfigs)) {
        return 'configuration_required';
      }
      const now = getServerNow();
      const newRunId = `${sessionId}-${now}` as ReviewRunId;
      const workspacePolicy = await readReviewPolicyFromFlock(runtime);
      const frozenPolicy: ReviewPolicy = {
        ...workspacePolicy,
        reviewer: machineReviewer.reviewer,
      };

      // The run is written BEFORE the authorization: the machine reacts to the
      // authorization, so publishing that first would race the engine into
      // reading a run that does not exist yet.
      await writeReviewRunToFlock(runtime, {
        id: newRunId,
        sessionId,
        mode,
        // Frozen here on purpose: editing the policy later must not change the
        // rules under a branch that is already being reviewed. A one-shot review
        // additionally gets a single round — it reports and stops.
        policy:
          mode === 'review_only'
            ? { ...frozenPolicy, budget: { ...frozenPolicy.budget, reviewRounds: 1 } }
            : frozenPolicy,
        state: 'reviewing',
        round: 1,
        ciFixUsed: 0,
        conflictUsed: 0,
        findings: [],
        events: [
          {
            at: now,
            state: 'reviewing',
            detail:
              mode === 'review_only'
                ? 'Review requested.'
                : 'Auto review and merge turned on.',
          },
        ],
        // Seeded with whatever turn is current so the user's own last message is
        // never mistaken for an interruption on the first pass.
        ...(currentMeta?.latestUserMsgId
          ? { lastEngineTurnId: currentMeta.latestUserMsgId }
          : {}),
        createdAt: now,
        updatedAt: now,
      });

      await runtime.writer.upsertDocMeta(roomId, {
        autoReview: { runId: newRunId, t: Math.floor(now / 1000) },
      } as Partial<SessionMeta>);
      return 'started';
    },
    [allAgentConfigs, runtime, sessionId]
  );

  const disable = useCallback(async () => {
    if (!runtime || !sessionId) {
      return;
    }
    const roomId = getSessionRoomId(sessionId);
    const existing = await runtime.repo.getDocMeta(roomId);
    if (isLoroRepoDocDeleted(existing)) {
      return;
    }
    // Clearing the authorization is what stops the engine; the run row goes too
    // so a later re-enable starts clean rather than resuming a spent budget.
    await runtime.writer.upsertDocMeta(roomId, {
      autoReview: undefined,
    } as Partial<SessionMeta>);
    await deleteReviewRunFromFlock(runtime, sessionId);
    setRun(undefined);
  }, [runtime, sessionId]);

  /**
   * Grants this run's merge.
   *
   * The policy's `mergeConfirmedOnce` cannot serve as the grant: its only writer
   * is the merge it gates, so without a per-run grant every run parked at the
   * confirmation prompt forever.
   */
  const confirmMerge = useCallback(async () => {
    if (!runtime || !sessionId) {
      return;
    }
    // Re-read before patching. Writing back a React copy is last-writer-wins
    // against the engine, so a stale copy would silently revert whatever it
    // wrote since this component last rendered — a failure count, an audit event.
    const current = await readReviewRunFromFlock(runtime, sessionId);
    if (!current) {
      return;
    }
    await writeReviewRunToFlock(runtime, {
      ...current,
      mergeConfirmed: true,
      updatedAt: getServerNow(),
    });
  }, [runtime, sessionId]);

  /**
   * Hands control back after a pause.
   *
   * Re-seeding the engine's turn marker is what actually un-pauses it: the
   * pause was triggered by `latestUserMsgId` no longer matching, so resuming
   * without re-seeding would pause again on the very next pass.
   */
  const resume = useCallback(async () => {
    if (!runtime || !sessionId) {
      return;
    }
    const current = await readReviewRunFromFlock(runtime, sessionId);
    if (!current) {
      return;
    }
    const existing = await runtime.repo.getDocMeta(getSessionRoomId(sessionId));
    const currentMeta = existing?.meta as SessionMeta | undefined;
    await writeReviewRunToFlock(runtime, {
      ...current,
      state: current.pausedFrom ?? 'reviewing',
      ...(currentMeta?.latestUserMsgId
        ? { lastEngineTurnId: currentMeta.latestUserMsgId }
        : {}),
      updatedAt: getServerNow(),
    });
  }, [runtime, sessionId]);

  return {
    /** A run of any kind is active on this session. */
    active: Boolean(autoReview),
    /** Specifically the standing "review and merge" mode the checkbox reflects. */
    enabled: Boolean(autoReview) && run?.mode !== 'review_only',
    /** Run state comes from the run row, the only writer of it. */
    state: run?.state,
    run,
    policy,
    reviewerConfig,
    reviewerConfigurationLoading: reviewerConfig === undefined,
    reviewerConfigurationReady,
    enable: () => start('review_and_merge'),
    reviewOnce: () => start('review_only'),
    confirmMerge,
    resume,
    disable,
  };
}
