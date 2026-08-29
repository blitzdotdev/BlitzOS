export type WorkspaceRemovalOrganization = {
  id: string;
  slug?: string | null;
};

export type WorkspaceRemovalTransition<TOrganization extends WorkspaceRemovalOrganization> = {
  isActiveOrganization: boolean;
  removedSlug: string | null;
  fallbackOrganization: TOrganization | undefined;
};

export function resolveWorkspaceRemovalTransition<
  TOrganization extends WorkspaceRemovalOrganization,
>({
  organizationId,
  organizations,
  activeOrganization,
}: {
  organizationId: string;
  organizations: readonly TOrganization[] | undefined;
  activeOrganization: WorkspaceRemovalOrganization | null | undefined;
}): WorkspaceRemovalTransition<TOrganization> {
  const organization = organizations?.find((org) => org.id === organizationId);
  const isActiveOrganization = activeOrganization?.id === organizationId;

  return {
    isActiveOrganization,
    removedSlug:
      organization?.slug ?? (isActiveOrganization ? (activeOrganization.slug ?? null) : null),
    fallbackOrganization: organizations?.find((org) => org.id !== organizationId),
  };
}
