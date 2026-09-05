/**
 * Where a `blitz connections open <provider>` focus LANDS, now that a
 * workspace's connections are a tab of the workspace-details dialog.
 *
 * The marker itself is pinned by `connections-focus.test.ts` and the shared
 * fixture corpus; nothing here may re-state its shape. What this covers is the
 * hop the shell makes after parsing one: it opens the dialog with the provider
 * on the dialog's own state, beside the tab it opens on, and the tab points at
 * that row.
 */
import type { CatalogEntryView, UserGrantView } from '@blitzos/schema';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import { WorkspaceConnectionsTab } from '../src/WorkspaceConnectionsTab.js';
import { render, settle } from './dom.js';
import { act as reactAct } from 'react';

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

function tab(focusProvider: { provider: string; at: number } | null = null) {
  return (
    <WorkspaceConnectionsTab
      client={client()}
      workspaceId="workspace-one"
      connections={['github']}
      focusProvider={focusProvider}
    />
  );
}

function focusedRow(container: HTMLElement): Element | null {
  return container.querySelector('.settings-switch-row--focus');
}

describe('connections focus destination', () => {
  it('points at the row the box named', async () => {
    const view = await render(tab({ provider: 'linear', at: 1_787_000_000_000 }));
    await settle();

    expect(focusedRow(view.container)?.textContent).toContain('Linear');
    await view.unmount();
  });

  it('points at nothing when the dialog was opened by a click', async () => {
    const view = await render(tab());
    await settle();

    expect(focusedRow(view.container)).toBeNull();
    await view.unmount();
  });

  it('re-points at a provider asked for again while the tab is open', async () => {
    const view = await render(tab({ provider: 'linear', at: 1_787_000_000_000 }));
    await settle();
    expect(focusedRow(view.container)?.textContent).toContain('Linear');

    // Each ask carries the box's own `requestedAt`, so the same provider asked
    // for twice is a new target rather than a no-op re-render.
    await reactAct(async () => {
      view.root.render(tab({ provider: 'github', at: 1_787_000_000_001 }));
    });
    await settle();
    expect(focusedRow(view.container)?.textContent).toContain('GitHub');
    await view.unmount();
  });

  /** The workspace filter the target used to carry is structural now: the
   * shell reads the marker for the workspace on screen and opens THAT
   * workspace's dialog, so a focus from another box cannot reach this tab. */
  it('is raised for the workspace on screen and no other', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const cloudApp = readFileSync(join(here, '..', 'src', 'CloudApp.tsx'), 'utf8');
    const handler = cloudApp.slice(cloudApp.indexOf('useWorkspaceConnectionsFocus('));
    const opens = handler.slice(0, handler.indexOf('});'));
    expect(opens).toContain('workspaceId: activeWorkspaceId');
    expect(opens).toContain("tab: 'connections'");
    expect(opens).toContain('at: focus.requestedAt');
  });
});
