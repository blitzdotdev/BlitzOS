import { describe, expect, it } from 'vitest';
import {
  resolveOptimisticWorkspaceRouteGuard,
  resolveWorkspaceAccessDeniedFallback,
} from '../src/lib/workspace-route-guard';

describe('resolveOptimisticWorkspaceRouteGuard', () => {
  it('waits when optimistic rendering still points at the previous workspace', () => {
    expect(
      resolveOptimisticWorkspaceRouteGuard({
        workspaceName: 'target-workspace',
        organizations: undefined,
        activeOrganization: { slug: 'previous-workspace' },
      })
    ).toBe('wait-for-switch');
  });

  it('waits until active workspace catches up when target access is confirmed', () => {
    expect(
      resolveOptimisticWorkspaceRouteGuard({
        workspaceName: 'target-workspace',
        organizations: [{ slug: 'target-workspace' }, { slug: 'previous-workspace' }],
        activeOrganization: { slug: 'previous-workspace' },
      })
    ).toBe('wait-for-switch');
  });

  it('surfaces a switch error instead of waiting forever when the switch fails before orgs load', () => {
    expect(
      resolveOptimisticWorkspaceRouteGuard({
        workspaceName: 'target-workspace',
        organizations: undefined,
        activeOrganization: { slug: 'previous-workspace' },
        error: new Error('Failed to switch organization'),
      })
    ).toBe('switch-error');
  });

  it('surfaces a switch error instead of waiting forever when the target org is known', () => {
    expect(
      resolveOptimisticWorkspaceRouteGuard({
        workspaceName: 'target-workspace',
        organizations: [{ slug: 'target-workspace' }, { slug: 'previous-workspace' }],
        activeOrganization: { slug: 'previous-workspace' },
        error: new Error('Failed to switch organization'),
      })
    ).toBe('switch-error');
  });

  it('renders when server access is confirmed even if active organization switching is stale', () => {
    expect(
      resolveOptimisticWorkspaceRouteGuard({
        workspaceName: 'target-workspace',
        organizations: [{ slug: 'target-workspace' }, { slug: 'previous-workspace' }],
        activeOrganization: { slug: 'previous-workspace' },
        error: new Error('Failed to switch organization'),
        serverAccessConfirmed: true,
      })
    ).toBe('render');
  });

  it('redirects when the target workspace is not in the accessible organization list', () => {
    expect(
      resolveOptimisticWorkspaceRouteGuard({
        workspaceName: 'missing-workspace',
        organizations: [{ slug: 'current-workspace' }],
        activeOrganization: { slug: 'current-workspace' },
      })
    ).toBe('redirect');
  });

  it('renders once the active workspace matches the route workspace', () => {
    expect(
      resolveOptimisticWorkspaceRouteGuard({
        workspaceName: 'target-workspace',
        organizations: [{ slug: 'target-workspace' }],
        activeOrganization: { slug: 'target-workspace' },
      })
    ).toBe('render');
  });

  it('renders when the target workspace is accessible but active organization is still hydrating', () => {
    expect(
      resolveOptimisticWorkspaceRouteGuard({
        workspaceName: 'target-workspace',
        organizations: [{ slug: 'target-workspace' }, { slug: 'previous-workspace' }],
        activeOrganization: null,
      })
    ).toBe('render');
  });
});

describe('resolveWorkspaceAccessDeniedFallback', () => {
  it('waits while the organization list is still loading', () => {
    expect(
      resolveWorkspaceAccessDeniedFallback({
        workspaceName: 'stale-workspace',
        organizations: undefined,
        activeOrganization: null,
      })
    ).toEqual({ kind: 'wait' });
  });

  it('uses the preferred workspace when it is an accessible fallback', () => {
    expect(
      resolveWorkspaceAccessDeniedFallback({
        workspaceName: 'stale-workspace',
        organizations: [{ slug: 'alpha' }, { slug: 'beta' }],
        activeOrganization: { slug: 'alpha' },
        preferredWorkspaceSlug: 'beta',
      })
    ).toEqual({ kind: 'workspace', slug: 'beta' });
  });

  it('uses the active workspace when the preferred workspace is not accessible', () => {
    expect(
      resolveWorkspaceAccessDeniedFallback({
        workspaceName: 'stale-workspace',
        organizations: [{ slug: 'alpha' }, { slug: 'beta' }],
        activeOrganization: { slug: 'alpha' },
        preferredWorkspaceSlug: 'missing',
      })
    ).toEqual({ kind: 'workspace', slug: 'alpha' });
  });

  it('uses the first accessible workspace when there is no preferred or active fallback', () => {
    expect(
      resolveWorkspaceAccessDeniedFallback({
        workspaceName: 'stale-workspace',
        organizations: [{ slug: 'alpha' }, { slug: 'beta' }],
        activeOrganization: null,
      })
    ).toEqual({ kind: 'workspace', slug: 'alpha' });
  });

  it('redirects to workspace creation when the resolved organization list is empty', () => {
    expect(
      resolveWorkspaceAccessDeniedFallback({
        workspaceName: 'stale-workspace',
        organizations: [],
        activeOrganization: null,
      })
    ).toEqual({ kind: 'create-workspace' });
  });

  it('waits when the only loaded organization is the denied workspace', () => {
    expect(
      resolveWorkspaceAccessDeniedFallback({
        workspaceName: 'stale-workspace',
        organizations: [{ slug: 'stale-workspace' }],
        activeOrganization: { slug: 'stale-workspace' },
      })
    ).toEqual({ kind: 'wait' });
  });
});
