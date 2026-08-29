import { compareTaskOrder, type TaskStatus } from '@lody/shared';

/**
 * Delegated automation policy: which entrusted tasks this machine should start
 * right now.
 *
 * All decisions live here as a pure function so the scheduler stays a thin
 * orchestrator, and so the rules that keep this from burning tokens by surprise
 * are directly testable.
 */

export type TaskAutomationCandidate = {
  taskId: string;
  /** Fractional index; doubles as the queue order for one agent. */
  order: string;
  ownerId: string;
  /** Absent means the task is never automated. */
  agentConfigId?: string | undefined;
  status: TaskStatus;
  /** Required execution inputs are present. */
  ready: boolean;
};

export type TaskAutomationInput = {
  candidates: readonly TaskAutomationCandidate[];
  /** Agents whose home machine is this machine. Others belong to someone else's scheduler. */
  ownedAgentConfigIds: ReadonlySet<string>;
  /** Of the owned agents, the ones whose machine is online and able to run now. */
  onlineAgentConfigIds: ReadonlySet<string>;
  /** The authenticated user of this machine. */
  operatorUserId: string;
  /** agentConfigId → taskId currently auto-executing for that agent. */
  inFlightByAgentConfigId: ReadonlyMap<string, string>;
  /**
   * Tasks that were already eligible when this scheduler started. They are
   * recorded, never started: firing on them would mean every restart replays
   * the backlog.
   */
  baselineTaskIds: ReadonlySet<string>;
  /** Tasks this scheduler already started, so a re-read cannot double-start. */
  startedTaskIds: ReadonlySet<string>;
};

export type TaskAutomationStart = { taskId: string; agentConfigId: string };

export type TaskAutomationQueued = {
  taskId: string;
  agentConfigId: string;
  /** 1-based position behind the agent's current work. */
  position: number;
};

export type TaskAutomationPlan = {
  start: TaskAutomationStart[];
  queued: TaskAutomationQueued[];
  /** Eligible, but the agent's machine is not online yet. */
  waitingForAgent: TaskAutomationStart[];
  /** Eligible at startup, deliberately not started. */
  skippedAsBaseline: string[];
};

/** Eligibility ignores queueing and liveness: it is purely "may this ever run". */
export const isTaskAutomationEligible = (
  candidate: TaskAutomationCandidate,
  input: Pick<TaskAutomationInput, 'ownedAgentConfigIds' | 'operatorUserId'>
): boolean => {
  const agentConfigId = candidate.agentConfigId;
  if (!agentConfigId) {
    // No entrusted agent: this task is never automated.
    return false;
  }
  // Both `backlog` and `todo` are "not started" — the split is a triage
  // refinement, not an execution gate — so both are eligible for pickup once
  // an agent is entrusted. `computeTaskQueuePositions` (shared) mirrors this
  // exact set for the "#N in queue" display; keep the two in sync.
  if (candidate.status !== 'backlog' && candidate.status !== 'todo') {
    return false;
  }
  if (!candidate.ready) {
    return false;
  }
  if (!input.ownedAgentConfigIds.has(agentConfigId)) {
    return false;
  }
  // Running someone else's task under this operator's credentials would
  // misattribute the work; cross-user delegation needs its own authorization
  // design before it can be allowed.
  return candidate.ownerId === input.operatorUserId;
};

export const planTaskAutomation = (input: TaskAutomationInput): TaskAutomationPlan => {
  const plan: TaskAutomationPlan = {
    start: [],
    queued: [],
    waitingForAgent: [],
    skippedAsBaseline: [],
  };

  // An agent is busy while its task is RUNNING, not merely while it is being
  // dispatched. `inFlightByAgentConfigId` only spans the dispatch call, so on the
  // next pass the agent would look free and a second task would start alongside
  // the first — two sessions for one agent, usually in the same working copy.
  // A task already in progress for this operator is the durable signal, and it
  // also makes a manual Run count as busy.
  const busyAgentConfigIds = new Set<string>(input.inFlightByAgentConfigId.keys());
  for (const candidate of input.candidates) {
    if (
      candidate.agentConfigId &&
      candidate.status === 'in_progress' &&
      candidate.ownerId === input.operatorUserId
    ) {
      busyAgentConfigIds.add(candidate.agentConfigId);
    }
  }

  const byAgent = new Map<string, TaskAutomationCandidate[]>();
  for (const candidate of input.candidates) {
    if (!isTaskAutomationEligible(candidate, input)) {
      continue;
    }
    if (input.startedTaskIds.has(candidate.taskId)) {
      continue;
    }
    if (input.baselineTaskIds.has(candidate.taskId)) {
      plan.skippedAsBaseline.push(candidate.taskId);
      continue;
    }
    const agentConfigId = candidate.agentConfigId as string;
    const bucket = byAgent.get(agentConfigId);
    if (bucket) {
      bucket.push(candidate);
    } else {
      byAgent.set(agentConfigId, [candidate]);
    }
  }

  for (const [agentConfigId, bucket] of byAgent) {
    // One agent works like one colleague: strictly in the order the user put
    // them in, one at a time.
    const ordered = [...bucket].sort((a, b) =>
      compareTaskOrder({ order: a.order, id: a.taskId }, { order: b.order, id: b.taskId })
    );

    if (!input.onlineAgentConfigIds.has(agentConfigId)) {
      for (const candidate of ordered) {
        plan.waitingForAgent.push({ taskId: candidate.taskId, agentConfigId });
      }
      continue;
    }

    const busy = busyAgentConfigIds.has(agentConfigId);
    // Position counts places in the queue, so the next task up is 1 whether the
    // agent is mid-task or the first candidate just claimed the slot.
    let position = 0;
    for (const [index, candidate] of ordered.entries()) {
      if (!busy && index === 0) {
        plan.start.push({ taskId: candidate.taskId, agentConfigId });
        continue;
      }
      position += 1;
      plan.queued.push({ taskId: candidate.taskId, agentConfigId, position });
    }
  }

  return plan;
};

/**
 * Tasks eligible right now, used once at startup to seed the baseline. Everything
 * it returns is deliberately never started by this run.
 */
export const collectTaskAutomationBaseline = (
  candidates: readonly TaskAutomationCandidate[],
  input: Pick<TaskAutomationInput, 'ownedAgentConfigIds' | 'operatorUserId'>
): Set<string> => {
  const baseline = new Set<string>();
  for (const candidate of candidates) {
    if (isTaskAutomationEligible(candidate, input)) {
      baseline.add(candidate.taskId);
    }
  }
  return baseline;
};
