import { describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import {
  createPreviewVisualComment,
  createPreviewVisualCommentDoc,
  type MinimalVisualAnnotationAnchor,
  type PreviewVisualCommentDocInput,
} from '@lody/shared';
import { createDirectWorkspaceWriter } from '../src/providers/workspace-writer-impl';

const anchor: MinimalVisualAnnotationAnchor = {
  version: 1,
  page: {
    url: 'http://localhost:5173',
    pathname: '/',
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
  },
  click: {
    clientX: 10,
    clientY: 20,
    pageX: 10,
    pageY: 20,
    viewportXRatio: 0.1,
    viewportYRatio: 0.2,
  },
  target: {
    tag: 'button',
    attributes: {},
    rect: { x: 0, y: 0, width: 100, height: 30 },
    rectRatio: { x: 0, y: 0, width: 0.1, height: 0.05 },
    selector: 'button',
  },
  context: { ancestors: [] },
};

describe('createDirectWorkspaceWriter', () => {
  it('puts a Flock row only when the key is absent in the same synchronous transaction', async () => {
    const flock = new Flock('workspace-writer-test');
    const writer = createDirectWorkspaceWriter({
      repo: {
        openFlockDoc: vi.fn(async () => ({ flock })),
      } as never,
      acquireSessionStore: vi.fn(async () => {
        throw new Error('not used');
      }),
      releaseSessionStoreRef: vi.fn(),
      acquirePreviewVisualCommentStore: vi.fn(async () => {
        throw new Error('not used');
      }),
      releasePreviewVisualCommentStoreRef: vi.fn(),
    });

    const results = await Promise.all([
      writer.flockRowPutIfAbsent('flock-1', ['localProject', 'project-1'], { name: 'first' }),
      writer.flockRowPutIfAbsent('flock-1', ['localProject', 'project-1'], { name: 'second' }),
    ]);
    expect(results).toEqual([
      { inserted: true, value: { name: 'first' } },
      { inserted: false, value: { name: 'first' } },
    ]);
    expect(flock.get(['localProject', 'project-1'])).toEqual({ name: 'first' });
  });

  it('applies the shared preview-comment mutation to the renderer store', async () => {
    const state = createPreviewVisualCommentDoc(
      'session-1' as never
    ) as PreviewVisualCommentDocInput;
    const setState = vi.fn((updater: (draft: PreviewVisualCommentDocInput) => void) => {
      updater(state);
    });
    const writer = createDirectWorkspaceWriter({
      repo: {} as never,
      acquireSessionStore: vi.fn(async () => {
        throw new Error('not used');
      }),
      releaseSessionStoreRef: vi.fn(),
      acquirePreviewVisualCommentStore: vi.fn(async () => ({ setState }) as never),
      releasePreviewVisualCommentStoreRef: vi.fn(),
    });
    const comment = createPreviewVisualComment({
      id: 'comment-1',
      turnId: 'turn-1',
      body: 'Persist me',
      anchor,
      authorId: 'user-1',
      createdAt: 1_000,
    });

    await writer.mutatePreviewVisualComments('session-1' as never, { kind: 'create', comment });
    expect(state.turns['turn-1']).toMatchObject({
      comments: [expect.objectContaining({ id: 'comment-1', body: 'Persist me' })],
    });
  });

  it('rejects when the underlying store write fails so send paths surface the error', async () => {
    const writer = createDirectWorkspaceWriter({
      repo: {} as never,
      acquireSessionStore: vi.fn(async () => {
        throw new Error('store unavailable');
      }),
      releaseSessionStoreRef: vi.fn(),
      acquirePreviewVisualCommentStore: vi.fn(async () => {
        throw new Error('not used');
      }),
      releasePreviewVisualCommentStoreRef: vi.fn(),
    });

    await expect(writer.appendSessionTurn('session-1', { id: 'turn-1' })).rejects.toThrow(
      'store unavailable'
    );
  });
});
