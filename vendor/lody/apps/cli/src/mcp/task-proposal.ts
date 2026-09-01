import {
  getServerNow,
  type MessageContent,
  type SessionHistoryInput,
  type SessionId,
  type TaskProposalMeta,
  TaskProposalMetaSchema,
} from '@lody/shared';
import { LodyOperationStoreError } from '@/orchestration/operation-store';

export type TaskProposalDraft = {
  proposalId: string;
  title: string;
  body?: string;
};

export type TaskProposalActor = {
  agentConfigId?: string;
  name?: string;
};

export type TaskProposalPublishResult =
  | { pending: true }
  | { pending: false; outcome: 'created'; taskId?: string }
  | { pending: false; outcome: 'dismissed' };

type TaskProposalDocument = {
  roomId: string;
  updateHistory(updateFn: (history: SessionHistoryInput[]) => SessionHistoryInput[]): Promise<void>;
};

export type TaskProposalPersistence = {
  repo: {
    flush(): Promise<void>;
  };
  getOrCreateSessionDoc(sessionId: SessionId): Promise<TaskProposalDocument>;
  syncDocOrThrow(docId: string, options?: { reason?: string }): Promise<void>;
};

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const syncProposalDoc = async (
  manager: Pick<TaskProposalPersistence, 'syncDocOrThrow'>,
  roomId: string,
  phase: 'hydrate' | 'commit'
): Promise<void> => {
  try {
    await manager.syncDocOrThrow(roomId, { reason: `mcp.task_propose:${phase}` });
  } catch (error) {
    const detail =
      phase === 'hydrate'
        ? 'The conversation could not be synchronized before writing the task proposal.'
        : 'The task proposal was saved locally, but remote synchronization was not confirmed.';
    throw new LodyOperationStoreError(
      'TASK_PROPOSAL_SYNC_FAILED',
      `${detail} Retry with the same proposalId; retries are idempotent. ${formatError(error)}`,
      true
    );
  }
};

const sameActor = (
  current: TaskProposalMeta['proposedBy'],
  desired: TaskProposalMeta['proposedBy']
): boolean =>
  current?.kind === desired?.kind &&
  current?.agentConfigId === desired?.agentConfigId &&
  current?.name === desired?.name;

const samePendingProposal = (current: TaskProposalMeta, desired: TaskProposalMeta): boolean =>
  current.proposalId === desired.proposalId &&
  current.title === desired.title &&
  current.body === desired.body &&
  current.outcome === undefined &&
  current.taskId === undefined &&
  sameActor(current.proposedBy, desired.proposedBy);

export const publishTaskProposal = async (
  manager: TaskProposalPersistence,
  sessionId: SessionId,
  draft: TaskProposalDraft,
  actor: TaskProposalActor,
  options: { now?: () => number } = {}
): Promise<TaskProposalPublishResult> => {
  const doc = await manager.getOrCreateSessionDoc(sessionId);

  // The MCP server owns this manager for one call only. Hydrating before the
  // conditional upsert and awaiting the commit sync are what make an `ok` reply
  // mean another client can actually observe the card after fast cleanup.
  await syncProposalDoc(manager, doc.roomId, 'hydrate');

  const desiredMeta: TaskProposalMeta = {
    proposalId: draft.proposalId,
    title: draft.title,
    ...(draft.body !== undefined ? { body: draft.body } : {}),
    proposedBy: {
      kind: 'agent',
      ...(actor.agentConfigId ? { agentConfigId: actor.agentConfigId } : {}),
      ...(actor.name ? { name: actor.name } : {}),
    },
  };
  const desiredItem: MessageContent = {
    type: 'system_notice',
    name: 'task_proposal',
    meta: desiredMeta,
  };
  const turnId = `task-proposal-${draft.proposalId}`;
  let changed = false;
  let result: TaskProposalPublishResult = { pending: true };

  await doc.updateHistory((history) => {
    const existingIndex = history.findIndex((entry) => entry.id === turnId);
    if (existingIndex < 0) {
      changed = true;
      return [
        ...history,
        {
          id: turnId,
          role: 'system',
          timestamp: new Date((options.now ?? getServerNow)()).toISOString(),
          items: [desiredItem],
          fileDiff: [],
          finished: true,
        },
      ];
    }

    const existing = history[existingIndex];
    const proposalItemIndex = existing?.items?.findIndex(
      (item) => item.type === 'system_notice' && item.name === 'task_proposal'
    );
    const proposalItem =
      proposalItemIndex !== undefined && proposalItemIndex >= 0
        ? existing?.items?.[proposalItemIndex]
        : undefined;
    const existingMetaValue =
      proposalItem?.type === 'system_notice' && proposalItem.name === 'task_proposal'
        ? proposalItem.meta
        : undefined;
    const parsedExistingMeta = TaskProposalMetaSchema.safeParse(existingMetaValue);
    const existingMeta = parsedExistingMeta.success ? parsedExistingMeta.data : undefined;

    if (!existing || proposalItemIndex === undefined || proposalItemIndex < 0 || !existingMeta) {
      throw new LodyOperationStoreError(
        'TASK_PROPOSAL_ID_CONFLICT',
        `History entry ${turnId} exists but is not a task proposal. Use a different proposalId.`,
        false
      );
    }
    if (existingMeta.proposalId !== draft.proposalId) {
      throw new LodyOperationStoreError(
        'TASK_PROPOSAL_ID_CONFLICT',
        `History entry ${turnId} belongs to a different proposal. Use a different proposalId.`,
        false
      );
    }
    if (existingMeta.outcome === 'created') {
      result = {
        pending: false,
        outcome: 'created',
        ...(existingMeta.taskId ? { taskId: existingMeta.taskId } : {}),
      };
      return history;
    }
    if (existingMeta.outcome === 'dismissed') {
      result = { pending: false, outcome: 'dismissed' };
      return history;
    }
    if (samePendingProposal(existingMeta, desiredMeta)) {
      return history;
    }

    const items = [...(existing.items ?? [])];
    items[proposalItemIndex] = desiredItem;
    const nextHistory = [...history];
    nextHistory[existingIndex] = { ...existing, items };
    changed = true;
    return nextHistory;
  });

  if (!changed) {
    return result;
  }

  await manager.repo.flush();
  await syncProposalDoc(manager, doc.roomId, 'commit');
  return result;
};
