import { describe, expect, it } from 'vitest';
import type { WorkspaceTab, WorkspaceTabs } from '../src/storage';
import {
  decodeWorkspaceSessionResponse,
  openSharedSessionTab,
  terminalKeyFor,
  type TtydWorkspaceSessionView,
} from '../src/workspace-sessions';

function session(
  overrides: Partial<TtydWorkspaceSessionView> = {},
): TtydWorkspaceSessionView {
  return {
    id: 'session-a',
    workspaceId: 'workspace',
    kind: 'claude',
    title: null,
    terminalKey: 'session-a',
    chatSessionId: null,
    chatProvider: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('terminal key resolution', () => {
  it('hands the box the key the shared session runs under, not the durable id', () => {
    const migrated = session({ id: 'legacy-workspace-7', terminalKey: '7' });
    const tab: WorkspaceTab = { id: 7, type: 'claude', sessionId: migrated.id };
    // A V1 tab kept attaching to tmux `claude-7`; after migration it still must.
    expect(terminalKeyFor(tab, [migrated])).toBe('7');
    expect(terminalKeyFor(tab, [session()])).toBe('legacy-workspace-7');
    expect(terminalKeyFor({ id: 3, type: 'terminal' }, [])).toBe('3');
  });
});

describe('opening a shared session in the personal view', () => {
  const tabs: WorkspaceTabs = {
    version: 1,
    tabs: [
      { id: 1, type: 'claude', sessionId: 'session-a' },
      { id: 2, type: 'panel', panel: 'files', region: 'side' },
      { id: 3, type: 'terminal', sessionId: 'session-b', region: 'side' },
    ],
    activeId: 1,
    nextId: 4,
    sideActiveId: 2,
  };

  it('selects an already-open session in its own pane instead of duplicating it', () => {
    const opened = openSharedSessionTab(tabs, session({ id: 'session-b', kind: 'terminal' }));
    expect(opened).toMatchObject({ tabId: 3, region: 'side', created: false });
    expect(opened.tabs.tabs).toHaveLength(3);
    expect(opened.tabs.sideActiveId).toBe(3);
    expect(opened.tabs.activeId).toBe(1);
  });

  it('appends a tab that references the shared ttyd session', () => {
    const shared = session({
      id: 'session-c',
      kind: 'codex',
    });
    const opened = openSharedSessionTab(tabs, shared);
    expect(opened).toMatchObject({ tabId: 4, region: 'main', created: true });
    // Main-pane tabs are inserted ahead of the side pane, not at the very end.
    expect(opened.tabs.tabs.find((tab) => tab.id === 4)).toEqual({
      id: 4,
      type: 'codex',
      sessionId: 'session-c',
    });
    expect(opened.tabs.activeId).toBe(4);
    expect(opened.tabs.nextId).toBe(5);
  });

  it('treats a same-id tab of a different kind as not open', () => {
    const opened = openSharedSessionTab(tabs, session({ id: 'session-a', kind: 'terminal' }));
    expect(opened.created).toBe(true);
  });
});

describe('shared session decoding', () => {
  it('requires a terminal key the box terminal would accept', () => {
    const wire = { session: session() };
    expect(decodeWorkspaceSessionResponse(JSON.stringify(wire)).session.terminalKey).toBe('session-a');
    expect(() => decodeWorkspaceSessionResponse(JSON.stringify({
      session: { ...wire.session, terminalKey: undefined },
    }))).toThrow('workspace session response is invalid');
    expect(() => decodeWorkspaceSessionResponse(JSON.stringify({
      session: { ...wire.session, terminalKey: 'claude 1' },
    }))).toThrow('workspace session response is invalid');
  });
});
