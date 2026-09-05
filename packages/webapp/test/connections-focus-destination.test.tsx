/**
 * Where a `blitz connections open <provider>` focus LANDS, now that a
 * workspace's connections are a tab of the workspace-details dialog.
 *
 * The marker itself is pinned by `connections-focus.test.ts` and the shared
 * fixture corpus; nothing here may re-state its shape. What this covers is the
 * hop the shell makes after parsing one: it publishes the target and opens the
 * dialog, and the tab — which mounts AFTER that publish — still finds it.
 */
import type { CatalogEntryView, UserGrantView } from '@blitzos/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import {
  clearConnectionsFocus,
  publishConnectionsFocus,
  useConnectionsFocusTarget,
} from '../src/connections-focus-target.js';
import { WorkspaceConnectionsTab } from '../src/WorkspaceConnectionsTab.js';
import { render, settle } from './dom.js';

// jsdom implements no scrolling, so the tab's "bring the row into view" call
// needs the stand-in every other scroll-touching suite here provides.
Element.prototype.scrollIntoView ??= () => {};

function entry(id: string, title: string): CatalogEntryView {
  return {
    id,
    title,
    summary: `${title} for agents`,
    custody: 'proxy',
    oauthAvailable: false,
    oauthConfigured: false,
    personalTokenLabel: 'API key',
    personalTokenFallbackOnly: false,
    personalTokenHelp: null,
    personalTokenBaseUrlLabel: null,
    adminForm: null,
  };
}

function grant(provider: string): UserGrantView {
  return {
    provider,
    manifestId: provider,
    kind: 'pat',
    label: null,
    scopes: [],
    createdAt: Date.UTC(2026, 8, 1),
    updatedAt: Date.UTC(2026, 8, 1),
    accessExpiresAt: null,
  };
}

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    listConnectionCatalog: vi.fn(async () => ({
      providers: [entry('github', 'GitHub'), entry('linear', 'Linear')],
    })),
    listConnectionGrants: vi.fn(async () => ({ grants: [grant('github')] })),
    mintWorkspaceConnection: vi.fn(),
    disconnectWorkspaceConnection: vi.fn(),
    ...overrides,
    // SAFETY: the tab reaches for the four connection calls above and nothing else.
  } as unknown as ControlPlaneClient;
}

function tab(workspaceId = 'workspace-one') {
  return (
    <WorkspaceConnectionsTab
      client={client()}
      workspaceId={workspaceId}
      connections={['github']}
    />
  );
}

function focusedRow(container: HTMLElement): Element | null {
  return container.querySelector('.settings-switch-row--focus');
}

afterEach(() => { clearConnectionsFocus(); });

describe('connections focus destination', () => {
  it('highlights the row the box pointed at, published before the tab mounts', async () => {
    // The order the shell does it in: publish, then open the dialog. A target
    // that only fired an event would be gone by the time the tab subscribed.
    publishConnectionsFocus({
      workspaceId: 'workspace-one',
      provider: 'linear',
      version: 1_787_000_000_000,
    });
    const view = await render(tab());
    await settle();

    expect(focusedRow(view.container)?.textContent).toContain('Linear');
    await view.unmount();
  });

  it('ignores a focus another workspace raised', async () => {
    publishConnectionsFocus({
      workspaceId: 'workspace-two',
      provider: 'linear',
      version: 1_787_000_000_000,
    });
    const view = await render(tab());
    await settle();

    expect(focusedRow(view.container)).toBeNull();
    await view.unmount();
  });

  it('re-points at a provider asked for again while the tab is open', async () => {
    const view = await render(tab());
    await settle();
    expect(focusedRow(view.container)).toBeNull();

    // Each ask carries the box's own `requestedAt`, so the same provider twice
    // is two targets and the row is pointed at again.
    await settle();
    publishConnectionsFocus({
      workspaceId: 'workspace-one',
      provider: 'github',
      version: 1_787_000_000_001,
    });
    await settle();
    expect(focusedRow(view.container)?.textContent).toContain('GitHub');
    await view.unmount();
  });

  it('hands a subscriber nothing once the target is cleared', async () => {
    publishConnectionsFocus({
      workspaceId: 'workspace-one',
      provider: 'github',
      version: 1,
    });
    clearConnectionsFocus();
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useConnectionsFocusTarget('workspace-one'));
      return null;
    }
    const view = await render(<Probe />);
    expect(seen[0]).toBeNull();
    await view.unmount();
  });
});
