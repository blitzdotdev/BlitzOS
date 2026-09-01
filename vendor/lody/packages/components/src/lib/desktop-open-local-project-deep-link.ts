import { readWorkspaceSlugFromPath } from './deep-link-path';

/**
 * Map a `lody://chat/new` deep link (fired by `lody app <dir>` in a terminal) to
 * the new-chat landing with that local project preselected. Mirrors
 * resolveDesktopCheckoutReturnDeepLinkPath.
 *
 * The link carries ids only. The CLI resolved — and, when needed, registered —
 * the directory before opening the app, so the app must never register a project
 * from a deep link: any web page can navigate the OS to `lody://…`, and turning
 * a link-supplied path into a local project would hand agents access to it.
 * An unknown project id simply stays unselected on the landing.
 *
 * Producer: `apps/cli/src/lib/desktop-deep-link.ts`.
 */
export function resolveDesktopOpenLocalProjectDeepLinkPath(
  deepLinkUrl: string,
  fallbackPathname = '/'
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(deepLinkUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'lody:' || parsed.hostname !== 'chat') {
    return null;
  }
  if (parsed.pathname.replace(/^\/+|\/+$/g, '') !== 'new') {
    return null;
  }

  const machineId = parsed.searchParams.get('machine')?.trim();
  const localProjectId = parsed.searchParams.get('project')?.trim();
  if (!machineId || !localProjectId) {
    return null;
  }

  // Without a slug the CLI could not tell which workspace to open; fall back to
  // the one already on screen (correct whenever the machine serves only one).
  const workspaceSlug =
    parsed.searchParams.get('workspaceSlug')?.trim() || readWorkspaceSlugFromPath(fallbackPathname);
  if (!workspaceSlug) {
    return null;
  }

  const targetSearchParams = new URLSearchParams({
    context: 'local',
    machine: machineId,
    project: localProjectId,
  });
  return `/${encodeURIComponent(workspaceSlug)}/chat?${targetSearchParams.toString()}`;
}
