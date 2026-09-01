import { describe, expect, it, vi } from 'vitest';
import type { AgentConfigMeta, MachineId, TaskIndexRow, WorkspaceId } from '@lody/shared';
import { TaskAutomationScheduler } from './task-automation-scheduler';

const MACHINE = 'machine-1' as MachineId;
const OPERATOR = 'user-1';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof makeScheduler>[0]['logger'];

const agentConfig = (id: string, machineId: MachineId = MACHINE): AgentConfigMeta =>
  ({ id, machineId, name: id, cliType: 'codex', agentType: 'codex' }) as AgentConfigMeta;

const row = (overrides: Partial<TaskIndexRow> = {}): TaskIndexRow => ({
  taskId: 't1',
  title: 'Task',
  status: 'backlog',
  ownerId: OPERATOR,
  order: '2',
  hasAgent: true,
  agentConfigId: 'agent-1',
  ready: true,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

function makeScheduler(options: {
  rows: TaskIndexRow[][];
  agents?: AgentConfigMeta[];
  online?: boolean;
  startTask?: (taskId: string, agentConfigId: string) => Promise<void>;
  logger?: unknown;
}) {
  const reads = [...options.rows];
  const started: string[] = [];
  const queued: { taskId: string; position: number }[] = [];
  const scheduler = new TaskAutomationScheduler({
    workspaceId: 'ws' as WorkspaceId,
    machineId: MACHINE,
    operatorUserId: OPERATOR,
    logger: (options.logger ?? logger) as never,
    readTaskIndex: async () => reads.shift() ?? [],
    listOwnedAgentConfigs: async () => options.agents ?? [agentConfig('agent-1')],
    isMachineOnline: () => options.online ?? true,
    startTask:
      options.startTask ??
      (async (taskId, agentConfigId) => {
        started.push(`${taskId}:${agentConfigId}`);
      }),
    onQueued: (taskId, position) => queued.push({ taskId, position }),
  });
  return { scheduler, started, queued };
}

describe('TaskAutomationScheduler', () => {
  it('records a baseline on the first pass and starts nothing', async () => {
    const { scheduler, started } = makeScheduler({ rows: [[row()]] });
    await scheduler.evaluate();
    expect(started).toEqual([]);
  });

  it('starts work that became eligible after the baseline', async () => {
    const { scheduler, started } = makeScheduler({
      rows: [[], [row({ taskId: 'new' })]],
    });
    await scheduler.evaluate();
    await scheduler.evaluate();
    expect(started).toEqual(['new:agent-1']);
  });

  it('never starts a task that was already waiting when it booted', async () => {
    const { scheduler, started } = makeScheduler({
      rows: [[row({ taskId: 'old' })], [row({ taskId: 'old' })]],
    });
    await scheduler.evaluate();
    await scheduler.evaluate();
    expect(started).toEqual([]);
  });

  it('lets a baseline task run once it leaves and re-enters the backlog', async () => {
    const { scheduler, started } = makeScheduler({
      rows: [
        [row({ taskId: 'old' })],
        // Moved out of backlog: it stops being pre-existing.
        [row({ taskId: 'old', status: 'done' })],
        // Reopened: this is a fresh observed transition.
        [row({ taskId: 'old' })],
      ],
    });
    await scheduler.evaluate();
    await scheduler.evaluate();
    await scheduler.evaluate();
    expect(started).toEqual(['old:agent-1']);
  });

  it('does not start the same task twice across passes', async () => {
    const { scheduler, started } = makeScheduler({
      rows: [[], [row({ taskId: 'a' })], [row({ taskId: 'a' })]],
    });
    await scheduler.evaluate();
    await scheduler.evaluate();
    await scheduler.evaluate();
    expect(started).toEqual(['a:agent-1']);
  });

  it('holds everything while the machine is offline', async () => {
    const { scheduler, started } = makeScheduler({
      rows: [[], [row({ taskId: 'a' })]],
      online: false,
    });
    await scheduler.evaluate();
    await scheduler.evaluate();
    expect(started).toEqual([]);
  });

  it('ignores agents that live on another machine', async () => {
    const { scheduler, started } = makeScheduler({
      rows: [[], [row({ taskId: 'a', agentConfigId: 'agent-remote' })]],
      agents: [agentConfig('agent-remote', 'machine-2' as MachineId)],
    });
    await scheduler.evaluate();
    await scheduler.evaluate();
    expect(started).toEqual([]);
  });

  it("ignores another user's task", async () => {
    const { scheduler, started } = makeScheduler({
      rows: [[], [row({ taskId: 'a', ownerId: 'user-2' })]],
    });
    await scheduler.evaluate();
    await scheduler.evaluate();
    expect(started).toEqual([]);
  });

  it('starts one task per agent and reports the rest as queued', async () => {
    const { scheduler, started, queued } = makeScheduler({
      rows: [
        [],
        [
          row({ taskId: 'a', order: '2' }),
          row({ taskId: 'b', order: '3' }),
          row({ taskId: 'c', order: '4' }),
        ],
      ],
    });
    await scheduler.evaluate();
    await scheduler.evaluate();
    expect(started).toEqual(['a:agent-1']);
    expect(queued).toEqual([
      { taskId: 'b', position: 1 },
      { taskId: 'c', position: 2 },
    ]);
  });

  it('coalesces overlapping evaluations instead of stacking passes', async () => {
    let reads = 0;
    const scheduler = new TaskAutomationScheduler({
      workspaceId: 'ws' as WorkspaceId,
      machineId: MACHINE,
      operatorUserId: OPERATOR,
      logger: logger as never,
      readTaskIndex: async () => {
        reads += 1;
        return [];
      },
      listOwnedAgentConfigs: async () => [agentConfig('agent-1')],
      isMachineOnline: () => true,
      startTask: async () => {},
    });
    await Promise.all([scheduler.evaluate(), scheduler.evaluate(), scheduler.evaluate()]);
    // One running pass plus at most one coalesced rerun — never one per caller.
    expect(reads).toBeLessThanOrEqual(2);
  });

  it('leaves a failed task retryable and does not wedge the agent', async () => {
    const attempts: string[] = [];
    const { scheduler } = makeScheduler({
      rows: [[], [row({ taskId: 'a' })], [row({ taskId: 'a' })]],
      startTask: async (taskId) => {
        attempts.push(taskId);
        throw new Error('dispatch failed');
      },
    });
    await scheduler.evaluate();
    await scheduler.evaluate();
    await scheduler.evaluate();
    expect(attempts).toEqual(['a', 'a']);
  });

  it('stops evaluating once stopped', async () => {
    const { scheduler, started } = makeScheduler({
      rows: [[], [row({ taskId: 'a' })]],
    });
    await scheduler.evaluate();
    scheduler.stop();
    await scheduler.evaluate();
    expect(started).toEqual([]);
  });
});
