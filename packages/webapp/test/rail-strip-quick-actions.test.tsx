/**
 * The right icon strip as a quick-action bar (`src/WorkspaceRailStrip.tsx`):
 * five buttons in the side panel's order, pressed and disabled off Lody's
 * reported state, and Connections on its own with the native fallback.
 */
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceRailStrip } from '../src/WorkspaceRailStrip.js';
import {
  BROWSER_SIDE_PANEL_ID,
  CONNECTIONS_SIDE_PANEL_ID,
  type SessionSidePanelHostState,
} from '../src/lody/side-panel.js';
import { render } from './dom.js';

const LABELS = ['Side Chat', 'Files', 'All Changes', 'Browser', 'Connections'];

function sessionState(
  overrides: Partial<SessionSidePanelHostState> = {},
): SessionSidePanelHostState {
  return {
    open: true,
    activeTabId: null,
    openedTabIds: [],
    availableOptions: [
      { id: 'side-session', disabled: false },
      { id: 'files', disabled: false },
      { id: 'changes', disabled: false },
      { id: BROWSER_SIDE_PANEL_ID, disabled: false },
      { id: CONNECTIONS_SIDE_PANEL_ID, disabled: false },
    ],
    ...overrides,
  };
}

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.webapp-rail-strip button')];
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    `.webapp-rail-strip button[aria-label="${label}"]`,
  );
  if (found === null) throw new Error(`no ${label} button`);
  return found;
}

describe('WorkspaceRailStrip', () => {
  it('draws the five panels in the side panel\'s order', async () => {
    const view = await render(
      <WorkspaceRailStrip
        sidePanel={sessionState()}
        connectionsOpen={false}
        landingSessionId={null}
        pendingRequestCount={0}
        onQuickAction={() => undefined}
      />,
    );
    expect(buttons(view.container).map((b) => b.getAttribute('aria-label'))).toEqual(LABELS);
    expect(buttons(view.container).every((b) => !b.disabled)).toBe(true);
    await view.unmount();
  });

  it('presses the icon of the tab in front and reports the press', async () => {
    const onQuickAction = vi.fn();
    const view = await render(
      <WorkspaceRailStrip
        sidePanel={sessionState({ activeTabId: 'changes', openedTabIds: ['files', 'changes'] })}
        connectionsOpen={false}
        landingSessionId={null}
        pendingRequestCount={0}
        onQuickAction={onQuickAction}
      />,
    );
    expect(button(view.container, 'All Changes').getAttribute('aria-pressed')).toBe('true');
    expect(button(view.container, 'Files').getAttribute('aria-pressed')).toBe('false');
    // Side Chat launches a session rather than toggling a tab: never pressed.
    expect(button(view.container, 'Side Chat').hasAttribute('aria-pressed')).toBe(false);
    await act(async () => button(view.container, 'All Changes').click());
    expect(onQuickAction).toHaveBeenCalledWith('changes');
    await view.unmount();
  });

  it('presses nothing while the side panel is collapsed', async () => {
    const view = await render(
      <WorkspaceRailStrip
        sidePanel={sessionState({ open: false, activeTabId: 'files', openedTabIds: ['files'] })}
        connectionsOpen={false}
        landingSessionId={null}
        pendingRequestCount={0}
        onQuickAction={() => undefined}
      />,
    );
    expect(button(view.container, 'Files').getAttribute('aria-pressed')).toBe('false');
    await view.unmount();
  });

  it('disables a panel the session does not offer, and keeps an already-open one', async () => {
    const view = await render(
      <WorkspaceRailStrip
        sidePanel={sessionState({
          openedTabIds: ['files'],
          availableOptions: [
            { id: 'side-session', disabled: true },
            { id: 'changes', disabled: false },
            { id: BROWSER_SIDE_PANEL_ID, disabled: false },
            { id: CONNECTIONS_SIDE_PANEL_ID, disabled: false },
          ],
        })}
        connectionsOpen={false}
        landingSessionId={null}
        pendingRequestCount={0}
        onQuickAction={() => undefined}
      />,
    );
    expect(button(view.container, 'Side Chat').disabled).toBe(true);
    // Files left the `+` menu because it is open; the strip still offers it.
    expect(button(view.container, 'Files').disabled).toBe(false);
    await view.unmount();
  });

  it('with no session on screen and none to open, offers Connections alone', async () => {
    const onQuickAction = vi.fn();
    const view = await render(
      <WorkspaceRailStrip
        sidePanel={null}
        connectionsOpen
        landingSessionId={null}
        pendingRequestCount={2}
        onQuickAction={onQuickAction}
      />,
    );
    const disabled = buttons(view.container)
      .filter((b) => b.disabled)
      .map((b) => b.getAttribute('aria-label'));
    expect(disabled).toEqual(['Side Chat', 'Files', 'All Changes', 'Browser']);
    const connections = button(view.container, 'Connections');
    expect(connections.getAttribute('aria-pressed')).toBe('true');
    expect(connections.querySelector('.workspace-pending-badge')?.textContent).toBe('2');
    await act(async () => connections.click());
    expect(onQuickAction).toHaveBeenCalledWith(CONNECTIONS_SIDE_PANEL_ID);
    // The one case where a disabled button is the honest answer, and it says
    // what to do about it rather than naming the state.
    expect(button(view.container, 'Files').title).toBe('Files — start a session first');
    await view.unmount();
  });

  it('offers every panel on the landing once there is a session to open one in', async () => {
    // THE CHAT LANDING WITH SESSIONS BEHIND IT is where a member spends the
    // moment before they send: the composer is on screen, the panels are not,
    // and the four buttons used to be dead there whatever they had open.
    const onQuickAction = vi.fn();
    const view = await render(
      <WorkspaceRailStrip
        sidePanel={null}
        connectionsOpen={false}
        landingSessionId="session-1"
        pendingRequestCount={0}
        onQuickAction={onQuickAction}
      />,
    );
    expect(buttons(view.container).some((b) => b.disabled)).toBe(false);
    expect(button(view.container, 'Files').title).toBe('Files — in your most recent session');
    // Connections keeps its own title: it opens here, not in a session.
    expect(button(view.container, 'Connections').title).toBe('Connections');
    await act(async () => button(view.container, 'Files').click());
    expect(onQuickAction).toHaveBeenCalledWith('files');
    await view.unmount();
  });

  it('says what a Side Chat waits for, rather than that the session refuses it', async () => {
    // A side chat forks an assistant turn, so before the agent's first reply
    // there is nothing to fork. The button stays disabled — upstream's own
    // launcher answers a click with an error toast — and the tooltip is what
    // separates "wait" from "never".
    const view = await render(
      <WorkspaceRailStrip
        sidePanel={sessionState({
          availableOptions: [
            { id: 'side-session', disabled: true },
            { id: 'files', disabled: false },
            { id: 'changes', disabled: false },
            { id: BROWSER_SIDE_PANEL_ID, disabled: false },
            { id: CONNECTIONS_SIDE_PANEL_ID, disabled: false },
          ],
        })}
        connectionsOpen={false}
        landingSessionId={null}
        pendingRequestCount={0}
        onQuickAction={() => undefined}
      />,
    );
    expect(button(view.container, 'Side Chat').title)
      .toBe("Side Chat — after the agent's first reply");
    await view.unmount();
  });
});
