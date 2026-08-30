import lodyLogo from '@/assets/lody-icon.png';

/**
 * Resolve the product-level workspace identity without changing the generic
 * WorkspaceAvatar fallback used by cloud organizations. A platform without
 * multi-workspace support has one implicit Lody workspace, so any stale or
 * synthetic organization logo must not leak into that nameplate.
 */
export function resolveWorkspaceIdentityLogo(
  organizationLogo: string | null | undefined,
  multiWorkspaceAvailable: boolean
): string | null {
  return multiWorkspaceAvailable ? (organizationLogo ?? null) : lodyLogo;
}
