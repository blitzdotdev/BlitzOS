import { describe, expect, it } from 'vitest';
import type { MachineId, SessionHistoryInput, SessionMeta } from '@lody/shared';
import {
  resolveDispatchAcpSessionId,
  resolveResumableAcpSessionId,
  resolveDispatchTurnInput,
  resolveSessionDispatchAction,
  type SessionDispatchSnapshot,
} from '../src/session/session-dispatch-logic';

const MACHINE_ID = 'machine-1' as MachineId;

const createUserTurn = (
  overrides: Partial<SessionHistoryInput> & Pick<SessionHistoryInput, 'items'>
): SessionHistoryInput => ({
  id: 'turn-1',
  role: 'user',
  timestamp: '2026-04-13T00:00:00.000Z',
  read: false,
  userId: 'user-1',
  fileDiff: [],
  ...overrides,
});

const createMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 'session-1',
    machineId: MACHINE_ID,
    createdAt: '2026-04-13T00:00:00.000Z',
    userId: 'user-1',
    cliType: 'builtin',
    agentType: 'codex',
    status: { type: 'idle' },
    ...overrides,
  }) as SessionMeta;

const createSnapshot = (
  overrides: Partial<SessionDispatchSnapshot> = {}
): SessionDispatchSnapshot => ({
  meta: createMeta(),
  history: [],
  hasActiveTurn: false,
  hasBlockingPendingCreate: false,
  hasReusableSession: false,
  ...overrides,
});

describe('resolveDispatchTurnInput', () => {
  it('uses configured input blocks when they parse successfully', () => {
    const entry = createUserTurn({
      inputConfig: {
        prompt: 'inspect this',
        cliType: 'builtin',
        agentType: 'codex',
        inputBlocks: [
          {
            type: 'image',
            imageId: 'img-1',
            mimeType: 'image/png',
            fileName: 'diagram.png',
            sizeBytes: 1234,
          },
          { type: 'text', text: 'inspect this' },
        ],
      },
      items: [{ type: 'text', text: 'history text' }],
    });

    expect(resolveDispatchTurnInput(entry)).toEqual({
      prompt: 'inspect this',
      inputBlocks: [
        {
          type: 'image',
          imageId: 'img-1',
          mimeType: 'image/png',
          fileName: 'diagram.png',
          sizeBytes: 1234,
        },
        { type: 'text', text: 'inspect this' },
      ],
    });
  });

  it('falls back to history blocks when configured input blocks cannot be parsed', () => {
    const entry = createUserTurn({
      inputConfig: {
        prompt: 'inspect this',
        cliType: 'builtin',
        agentType: 'codex',
        inputBlocks: [
          {
            type: 'image',
            imageId: 'img-1',
            mimeType: 'image/png',
            fileName: 'diagram.png',
            sizeBytes: 1234,
            width: 0,
          } as unknown as NonNullable<
            NonNullable<SessionHistoryInput['inputConfig']>['inputBlocks']
          >[number],
          { type: 'text', text: 'inspect this' },
        ],
      },
      items: [
        {
          type: 'image',
          text: undefined,
          imageId: 'img-1',
          mimeType: 'image/png',
          fileName: 'diagram.png',
          sizeBytes: 1234,
        },
        { type: 'text', text: 'inspect this' },
      ],
    });

    expect(resolveDispatchTurnInput(entry)).toEqual({
      prompt: 'inspect this',
      inputBlocks: [
        {
          type: 'image',
          imageId: 'img-1',
          mimeType: 'image/png',
          fileName: 'diagram.png',
          sizeBytes: 1234,
          width: undefined,
          height: undefined,
        },
        { type: 'text', text: 'inspect this' },
      ],
    });
  });
});

describe('resolveSessionDispatchAction', () => {
  it('keeps active status blocked only while a turn owner exists', () => {
    const action = resolveSessionDispatchAction(
      createSnapshot({
        meta: createMeta({ status: { type: 'running' } }),
        hasActiveTurn: true,
        hasReusableSession: true,
      }),
      MACHINE_ID
    );

    expect(action).toEqual({ type: 'noop', reason: 'active-session' });
  });

  it('repairs active status when only a reusable session resource remains', () => {
    const action = resolveSessionDispatchAction(
      createSnapshot({
        meta: createMeta({ status: { type: 'running' } }),
        hasActiveTurn: false,
        hasReusableSession: true,
      }),
      MACHINE_ID
    );

    expect(action).toEqual({ type: 'reset-stale-status', statusType: 'running' });
  });

  it('blocks only pending creates owned by an active turn', () => {
    const action = resolveSessionDispatchAction(
      createSnapshot({
        meta: createMeta({ status: { type: 'initializing' } }),
        hasActiveTurn: true,
        hasBlockingPendingCreate: true,
      }),
      MACHINE_ID
    );

    expect(action).toEqual({ type: 'noop', reason: 'pending-create' });
  });

  it('does not let stale pending-create resources block dispatch recovery', () => {
    const action = resolveSessionDispatchAction(
      createSnapshot({
        meta: createMeta({ status: { type: 'initializing' } }),
        hasActiveTurn: false,
        hasBlockingPendingCreate: false,
        hasReusableSession: false,
      }),
      MACHINE_ID
    );

    expect(action).toEqual({ type: 'reset-stale-status', statusType: 'initializing' });
  });

  it('dispatches follow-up turns through a reusable session after stale status repair', () => {
    const turn = createUserTurn({
      id: 'turn-2',
      status: 'pending',
      read: false,
      items: [{ type: 'text', text: 'next' }],
    });

    const action = resolveSessionDispatchAction(
      createSnapshot({
        meta: createMeta({ status: { type: 'idle' }, latestUserMsgId: 'turn-2' }),
        history: [turn],
        hasReusableSession: true,
      }),
      MACHINE_ID
    );

    expect(action).toEqual({ type: 'dispatch', mode: 'continue', turn });
  });

  it('does not dispatch imported handled history even when an ACP id exists', () => {
    const action = resolveSessionDispatchAction(
      createSnapshot({
        meta: createMeta({
          status: { type: 'idle' },
          acpSessionId: 'codex-session-1' as never,
          latestUserMsgId: 'turn-1',
          lastHandledUserMsgId: 'turn-1',
        }),
        history: [
          createUserTurn({
            id: 'turn-1',
            status: 'handled',
            read: true,
            inputConfig: {
              prompt: 'imported prompt',
              cliType: 'builtin',
              agentType: 'codex',
            },
            items: [{ type: 'text', text: 'imported prompt' }],
          }),
        ],
      }),
      MACHINE_ID
    );

    expect(action).toEqual({ type: 'no-dispatchable-turn' });
  });

  it('does not dispatch imported Codex replay turns that were stored as seen', () => {
    const action = resolveSessionDispatchAction(
      createSnapshot({
        meta: createMeta({
          status: { type: 'idle' },
          acpSessionId: 'codex-session-1' as never,
          externalHistory: {
            provider: { cliType: 'builtin', agentType: 'codex' },
            source: 'local-acp-history',
            sourceAcpSessionId: 'codex-session-1' as never,
            importedTurnCount: 1,
            importedTurnHashes: ['hash-1'],
            lastSyncAt: 1,
          },
        }),
        history: [
          createUserTurn({
            id: 'builtin:codex:codex-session-1:turn:0:abc',
            status: 'seen',
            read: true,
            items: [{ type: 'text', text: 'imported prompt' }],
          }),
        ],
      }),
      MACHINE_ID
    );

    expect(action).toEqual({ type: 'no-dispatchable-turn' });
  });

  it('does not dispatch imported Claude replay turns that were stored as seen', () => {
    const action = resolveSessionDispatchAction(
      createSnapshot({
        meta: createMeta({
          status: { type: 'idle' },
          acpSessionId: 'claude-session-1' as never,
          externalHistory: {
            provider: { cliType: 'builtin', agentType: 'claude' },
            source: 'local-acp-history',
            sourceAcpSessionId: 'claude-session-1' as never,
            importedTurnCount: 1,
            importedTurnHashes: ['hash-1'],
            lastSyncAt: 1,
          },
        }),
        history: [
          createUserTurn({
            id: 'builtin:claude:claude-session-1:turn:0:abc',
            status: 'seen',
            read: true,
            items: [{ type: 'text', text: 'imported prompt' }],
          }),
        ],
      }),
      MACHINE_ID
    );

    expect(action).toEqual({ type: 'no-dispatchable-turn' });
  });

  it('continues a newly imported Codex session through its external source id', () => {
    const turn = createUserTurn({
      id: 'new-turn',
      status: 'pending',
      read: false,
      items: [{ type: 'text', text: 'follow up' }],
    });

    const meta = createMeta({
      status: { type: 'idle' },
      externalHistory: {
        provider: { cliType: 'builtin', agentType: 'codex' },
        source: 'local-acp-history',
        sourceAcpSessionId: 'source-codex-session' as never,
        importedTurnCount: 1,
        importedTurnHashes: ['hash-1'],
        lastSyncAt: 1,
        status: 'synced',
      },
    });

    const action = resolveSessionDispatchAction(
      createSnapshot({
        meta,
        history: [turn],
      }),
      MACHINE_ID
    );

    expect(resolveDispatchAcpSessionId(meta)).toBe('source-codex-session');
    expect(action).toEqual({ type: 'dispatch', mode: 'continue', turn });
  });

  it('allows a later live ACP session id when it differs from the Codex source id', () => {
    const meta = createMeta({
      origin: 'external-acp',
      acpSessionId: 'live-lody-session' as never,
      externalHistory: {
        provider: { cliType: 'builtin', agentType: 'codex' },
        source: 'local-acp-history',
        sourceAcpSessionId: 'source-codex-session' as never,
        importedTurnCount: 1,
        importedTurnHashes: ['hash-1'],
        lastSyncAt: 1,
      },
    });

    expect(resolveResumableAcpSessionId(meta)).toBe('live-lody-session');
  });
});
