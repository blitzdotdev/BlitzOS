import { describe, expect, it } from 'vitest';
import { decodePresenceSnapshotResponse, presenceViewForTabs } from '../src/presence';
import type { WorkspaceTab } from '../src/storage';

describe('presence wire decoding', () => {
  it('decodes authorized, redacted, and organization activities', () => {
    const decoded = decodePresenceSnapshotResponse(JSON.stringify({
      serverTime: 10,
      expiresAfterMs: 35_000,
      members: [{
        membershipId: 'member',
        userId: 'user',
        name: 'Person',
        avatarUrl: null,
        state: 'active',
        activities: [
          {
            location: 'workspace',
            workspaceId: 'workspace',
            workspaceName: 'brave-otter',
            surfaces: [{
              kind: 'session',
              sessionId: 'session',
              sessionKind: 'terminal',
              title: 'Pairing',
            }],
            focusedSurface: 0,
            visible: true,
            focused: true,
            lastSeenAt: 9,
          },
          { location: 'other-workspace', visible: true, focused: false, lastSeenAt: 8 },
          { location: 'organization', visible: false, focused: false, lastSeenAt: 7 },
        ],
      }],
    }));
    expect(decoded.expiresAfterMs).toBe(35_000);
    expect(decoded.members[0]).toMatchObject({ state: 'active' });
    expect(decoded.members[0]?.activities.map(({ location }) => location)).toEqual([
      'workspace',
      'other-workspace',
      'organization',
    ]);
  });

  it('rejects malformed activity and focus data', () => {
    expect(() => decodePresenceSnapshotResponse(JSON.stringify({
      serverTime: 1,
      expiresAfterMs: 35_000,
      members: [{
        membershipId: 'member',
        userId: 'user',
        name: 'Person',
        avatarUrl: null,
        state: 'active',
        activities: [{
          location: 'workspace',
          workspaceId: 'workspace',
          workspaceName: 'Workspace',
          surfaces: [],
          focusedSurface: 0,
          visible: true,
          focused: true,
          lastSeenAt: 1,
        }],
      }],
    }))).toThrow('invalid members');
  });
});

describe('presence surface normalization', () => {
  it('reports at most two visible surfaces without file paths or numeric session keys', () => {
    const tabs: WorkspaceTab[] = [
      { id: 1, type: 'terminal', sessionId: 'shared-terminal' },
      { id: 2, type: 'file', filePath: '/workspace/secrets/README.md' },
      { id: 3, type: 'preview', port: 3000 },
    ];
    expect(presenceViewForTabs('workspace', tabs, [1, 2, 3], 2)).toEqual({
      workspaceId: 'workspace',
      surfaces: [
        { kind: 'session', sessionId: 'shared-terminal' },
        { kind: 'file', surfaceId: 'tab-2', label: 'README.md' },
      ],
      focusedSurface: 1,
    });
  });

  it('falls back to the workspace when no normalized visible tab is available', () => {
    expect(presenceViewForTabs(
      'workspace',
      [{ id: 1, type: 'terminal' }],
      [1],
      1,
    )).toEqual({
      workspaceId: 'workspace',
      surfaces: [{ kind: 'workspace' }],
      focusedSurface: 0,
    });
    expect(presenceViewForTabs(null, [], [], null)).toEqual({
      workspaceId: null,
      surfaces: [],
      focusedSurface: null,
    });
  });
});
