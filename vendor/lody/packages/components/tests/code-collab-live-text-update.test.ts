import { describe, expect, it } from 'vitest';
import {
  decideCodeCollabLiveTextUpdate,
  RecentLocalTextEchoTracker,
} from '../src/lib/code-collab-live-text-update';

describe('code collab live text update decisions', () => {
  it('acknowledges a live update that already matches the editor', () => {
    expect(
      decideCodeCollabLiveTextUpdate({
        incomingText: 'current text',
        currentEditorText: 'current text',
        isRecentLocalEcho: false,
      })
    ).toEqual({ kind: 'ack-current', text: 'current text' });
  });

  it('ignores a stale live update that matches a recent local edit', () => {
    expect(
      decideCodeCollabLiveTextUpdate({
        incomingText: 'local text that already went out',
        currentEditorText: 'newer local text',
        isRecentLocalEcho: true,
      })
    ).toEqual({ kind: 'ignore-local-echo', text: 'local text that already went out' });
  });

  it('applies a real external update as provider-authoritative text', () => {
    expect(
      decideCodeCollabLiveTextUpdate({
        incomingText: 'remote text',
        currentEditorText: 'local dirty text',
        isRecentLocalEcho: false,
      })
    ).toEqual({ kind: 'external', text: 'remote text' });
  });

  it('forces the first live update when no open baseline exists yet', () => {
    expect(
      decideCodeCollabLiveTextUpdate({
        incomingText: 'remote text',
        currentEditorText: undefined,
        isRecentLocalEcho: false,
      })
    ).toEqual({ kind: 'external', text: 'remote text' });
  });
});

describe('RecentLocalTextEchoTracker', () => {
  it('remembers recent local text snapshots and evicts old entries', () => {
    const tracker = new RecentLocalTextEchoTracker(2);
    tracker.remember('one');
    tracker.remember('two');

    expect(tracker.has('one')).toBe(true);
    expect(tracker.has('two')).toBe(true);

    tracker.remember('three');

    expect(tracker.has('one')).toBe(false);
    expect(tracker.has('two')).toBe(true);
    expect(tracker.has('three')).toBe(true);
  });

  it('can be cleared when switching files', () => {
    const tracker = new RecentLocalTextEchoTracker();
    tracker.remember('local text');
    tracker.clear();

    expect(tracker.has('local text')).toBe(false);
  });
});
