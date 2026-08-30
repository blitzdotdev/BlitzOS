import { describe, expect, it } from 'vitest';
import { resolveTaskSessionActivity } from '../src/components/tasks/task-session-activity';

describe('resolveTaskSessionActivity', () => {
  it('says nothing about a session this client has no meta for', () => {
    // Not "idle": a linked conversation that has not synced here is unknown,
    // and drawing unknown as finished is a false statement about the work.
    expect(resolveTaskSessionActivity(undefined)).toBeNull();
  });

  it('reports a live turn and a starting session apart', () => {
    expect(resolveTaskSessionActivity({ status: { type: 'running' } })).toBe('running');
    expect(resolveTaskSessionActivity({ status: { type: 'initializing' } })).toBe('starting');
    expect(resolveTaskSessionActivity({ status: { type: 'idle' } })).toBe('idle');
    expect(resolveTaskSessionActivity({})).toBe('idle');
  });

  it('keeps needs-you when the heartbeat TTL has repaired the status back to idle', () => {
    // The machine went offline holding a question. `awaitingUserSince` is the
    // durable fact; `status` is only the live accelerator, so reading status
    // alone would drop the signal exactly when it matters most.
    expect(
      resolveTaskSessionActivity({ status: { type: 'idle' }, awaitingUserSince: 1_700_000_000_000 })
    ).toBe('needs-you');
    expect(resolveTaskSessionActivity({ status: { type: 'requestPermission' } })).toBe('needs-you');
  });

  it('prefers needs-you over a running turn', () => {
    // Both can be true mid-turn (the agent asked and is still streaming); the
    // one that requires a human is the one worth showing.
    expect(
      resolveTaskSessionActivity({
        status: { type: 'running' },
        awaitingUserSince: 1_700_000_000_000,
      })
    ).toBe('needs-you');
  });
});
