type WorkspaceRouteLike = {
  slug?: string | null;
};

type ResolveOptimisticWorkspaceRouteGuardArgs = {
  workspaceName: string;
  organizations: WorkspaceRouteLike[] | undefined;
  activeOrganization: WorkspaceRouteLike | null | undefined;
  error?: unknown;
  serverAccessConfirmed?: boolean;
};

export type OptimisticWorkspaceRouteGuardResult =
  | 'render'
  | 'wait-for-switch'
  | 'switch-error'
  | 'redirect';

type ResolveWorkspaceAccessDeniedFallbackArgs = {
  workspaceName: string;
  organizations: WorkspaceRouteLike[] | undefined;
  activeOrganization: WorkspaceRouteLike | null | undefined;
  preferredWorkspaceSlug?: string | null;
};

export type WorkspaceAccessDeniedFallbackResult =
  | { kind: 'wait' }
  | { kind: 'workspace'; slug: string }
  | { kind: 'create-workspace' };

export function resolveOptimisticWorkspaceRouteGuard({
  workspaceName,
  organizations,
  activeOrganization,
  error,
  serverAccessConfirmed = false,
}: ResolveOptimisticWorkspaceRouteGuardArgs): OptimisticWorkspaceRouteGuardResult {
  if (serverAccessConfirmed) {
    return 'render';
  }

  const hasOrganizations = Array.isArray(organizations);
  const activeWorkspaceSlug = activeOrganization?.slug ?? null;

  if (hasOrganizations && organizations.length > 0) {
    const hasAccess = organizations.some((organization) => organization.slug === workspaceName);
    if (!hasAccess) {
      return 'redirect';
    }
    if (activeWorkspaceSlug && activeWorkspaceSlug !== workspaceName) {
      return error ? 'switch-error' : 'wait-for-switch';
    }
    return 'render';
  }

  if (activeWorkspaceSlug && activeWorkspaceSlug !== workspaceName) {
    return error ? 'switch-error' : 'wait-for-switch';
  }

  return 'render';
}

export function resolveWorkspaceAccessDeniedFallback({
  workspaceName,
  organizations,
  activeOrganization,
  preferredWorkspaceSlug,
}: ResolveWorkspaceAccessDeniedFallbackArgs): WorkspaceAccessDeniedFallbackResult {
  if (!Array.isArray(organizations)) {
    return { kind: 'wait' };
  }

  const fallbackSlugs = organizations
    .map((organization) => organization.slug ?? null)
    .filter((slug): slug is string => Boolean(slug) && slug !== workspaceName);

  if (fallbackSlugs.length > 0) {
    if (preferredWorkspaceSlug && fallbackSlugs.includes(preferredWorkspaceSlug)) {
      return { kind: 'workspace', slug: preferredWorkspaceSlug };
    }

    const activeWorkspaceSlug = activeOrganization?.slug ?? null;
    if (activeWorkspaceSlug && fallbackSlugs.includes(activeWorkspaceSlug)) {
      return { kind: 'workspace', slug: activeWorkspaceSlug };
    }

    const firstFallbackSlug = fallbackSlugs[0];
    if (firstFallbackSlug) {
      return { kind: 'workspace', slug: firstFallbackSlug };
    }
  }

  if (organizations.length === 0) {
    return { kind: 'create-workspace' };
  }

  return { kind: 'wait' };
}
