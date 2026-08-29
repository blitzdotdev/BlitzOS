import { describe, expect, it } from 'vitest';

import { mergeBootstrapMetaCache } from '../src/lib/doc-meta-bootstrap';

describe('mergeBootstrapMetaCache', () => {
  it('keeps snapshot fields when live cache only has a partial patch', () => {
    const merged = mergeBootstrapMetaCache(
      {
        'session-1': {
          id: 'session-1',
          title: 'Synced title',
          status: { type: 'running' },
        },
      },
      {
        'session-1': {
          id: 'session-1',
          status: { type: 'idle' },
        },
      }
    );

    expect(merged['session-1']).toEqual({
      id: 'session-1',
      title: 'Synced title',
      status: { type: 'idle' },
    });
  });

  it('drops docs marked deleted while bootstrap scan was still in flight', () => {
    const merged = mergeBootstrapMetaCache(
      {
        'session-1': {
          id: 'session-1',
          title: 'Should disappear',
        },
      },
      {},
      new Map([['session-1', 'deleted']])
    );

    expect(merged['session-1']).toBeUndefined();
  });

  it('keeps snapshot docs when the existence marker was cleared during bootstrap', () => {
    const merged = mergeBootstrapMetaCache(
      {
        'session-1': {
          id: 'session-1',
          title: 'Should stay visible',
        },
      },
      {},
      new Map([['session-1', 'missing']])
    );

    expect(merged['session-1']).toEqual({
      id: 'session-1',
      title: 'Should stay visible',
    });
  });

  it('keeps live docs that became active during bootstrap even if snapshot missed them', () => {
    const merged = mergeBootstrapMetaCache(
      {},
      {
        'session-2': {
          id: 'session-2',
          title: 'Restored task',
        },
      },
      new Map([['session-2', 'active']])
    );

    expect(merged['session-2']).toEqual({
      id: 'session-2',
      title: 'Restored task',
    });
  });
});
