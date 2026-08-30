/** Extract the leading workspace slug from an in-app path (`/slug/...`). */
export function readWorkspaceSlugFromPath(pathname: string): string | null {
  const [workspaceSlug] = pathname.split('/').filter(Boolean);
  return workspaceSlug || null;
}
