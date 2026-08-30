import { describe, expect, it } from 'vitest';
import type { SessionId } from '@lody/shared';
import {
  getSessionNavigationLocation,
  resolveOpenedByNavigationTarget,
} from '../src/lib/session-navigation';

const sessionId = (value: string) => value as SessionId;

describe('resolveOpenedByNavigationTarget', () => {
  it('returns the root Session when the opener is already a root', () => {
    expect(
      resolveOpenedByNavigationTarget({ openedBySessionId: sessionId('root-session') })
    ).toEqual({ sessionId: 'root-session' });
  });

  it('restores the exact opener Tab from persisted relationship metadata', () => {
    expect(
      resolveOpenedByNavigationTarget({
        openedBySessionId: sessionId('child-tab'),
        openedByRootSessionId: sessionId('root-session'),
      })
    ).toEqual({ sessionId: 'root-session', tabSessionId: 'child-tab' });
  });

  it('resolves legacy child-Tab relationships from the opener metadata', () => {
    expect(
      resolveOpenedByNavigationTarget(
        { openedBySessionId: sessionId('child-tab') },
        { parentSessionId: sessionId('root-session') }
      )
    ).toEqual({ sessionId: 'root-session', tabSessionId: 'child-tab' });
  });
});

describe('getSessionNavigationLocation', () => {
  it('encodes the exact Tab in the root Session route', () => {
    expect(
      getSessionNavigationLocation({
        sessionId: sessionId('root-session'),
        tabSessionId: sessionId('child-tab'),
      })
    ).toEqual({ sessionId: 'root-session', tab: 'session:child-tab' });
  });

  it('omits the tab search for a root Session target', () => {
    expect(getSessionNavigationLocation({ sessionId: sessionId('root-session') })).toEqual({
      sessionId: 'root-session',
      tab: undefined,
    });
  });
});
