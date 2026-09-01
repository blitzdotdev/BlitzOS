import { describe, expect, it } from 'vitest';
import {
  LODY_CLAUDE_TASK_LIFECYCLE_RAW_INPUT_KEY,
  mergeSubagentTaskPayload,
  parseSubagentTaskWire,
} from '../src/acp/claude-subagent-task';
import type { SubagentTaskPayload } from '../src/ai';

const wire = (payload: Record<string, unknown>) => ({
  [LODY_CLAUDE_TASK_LIFECYCLE_RAW_INPUT_KEY]: payload,
});

describe('parseSubagentTaskWire', () => {
  it('parses a well-formed wire payload and strips unknown keys', () => {
    const parsed = parseSubagentTaskWire(
      wire({
        version: 1, // not part of the payload schema → stripped
        event: 'task_started',
        taskId: 'task-1',
        status: 'in_progress',
        subagentType: 'Explore',
        description: 'Find X',
        isBackgrounded: true,
        workflowName: 'spec',
      })
    );
    expect(parsed).toMatchObject({
      event: 'task_started',
      taskId: 'task-1',
      status: 'in_progress',
      subagentType: 'Explore',
      description: 'Find X',
      isBackgrounded: true,
      workflowName: 'spec',
    });
    expect(parsed && 'version' in parsed).toBe(false);
  });

  it('returns null when the wire carrier is absent', () => {
    expect(parseSubagentTaskWire({ other: 1 })).toBeNull();
    expect(parseSubagentTaskWire(undefined)).toBeNull();
    expect(parseSubagentTaskWire('nope')).toBeNull();
  });

  it('returns null for malformed payloads (missing taskId / bad status)', () => {
    expect(
      parseSubagentTaskWire(wire({ event: 'task_started', status: 'in_progress' }))
    ).toBeNull();
    expect(parseSubagentTaskWire(wire({ taskId: 't', status: 'weird' }))).toBeNull();
  });
});

describe('mergeSubagentTaskPayload', () => {
  it('preserves earlier-event fields while later events win', () => {
    const started: SubagentTaskPayload = {
      taskId: 'task-1',
      status: 'in_progress',
      event: 'task_started',
      subagentType: 'Explore',
      description: 'Find codex refresh logic',
    };
    const notification: SubagentTaskPayload = {
      taskId: 'task-1',
      status: 'completed',
      event: 'task_notification',
      summary: 'All done',
    };

    expect(mergeSubagentTaskPayload(started, notification)).toEqual({
      taskId: 'task-1',
      status: 'completed',
      event: 'task_notification',
      summary: 'All done',
      subagentType: 'Explore',
      description: 'Find codex refresh logic',
    });
  });
});
