import { readWorkspaceSlugFromPath } from './deep-link-path';

/**
 * Where to land after the GitHub install deep link returns.
 *
 * - `'settings'`: the integrations page (default — matches the flow when the
 *   user kicked install off from settings and expects to see the result).
 * - `'home'`: the workspace home (`/chat`) — used when install was kicked off
 *   from the onboarding overlay, since landing on a settings page mid-flow
 *   leaves the user behind a covered settings UI once they finish.
 */
export type DesktopGitHubInstallReturnTarget = 'settings' | 'home';

export function resolveDesktopGitHubInstallDeepLinkPath(
  deepLinkUrl: string,
  fallbackPathname = '/',
  options?: { target?: DesktopGitHubInstallReturnTarget }
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(deepLinkUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'lody:' || parsed.hostname !== 'github-install') {
    return null;
  }

  const workspaceSlug =
    parsed.searchParams.get('workspaceSlug')?.trim() || readWorkspaceSlugFromPath(fallbackPathname);
  if (!workspaceSlug) {
    return null;
  }

  const target = options?.target ?? 'settings';
  const subpath = target === 'home' ? '/chat' : '/settings/github';

  const targetSearchParams = new URLSearchParams();
  if (parsed.searchParams.get('installed') === 'true') {
    targetSearchParams.set('installed', 'true');
  }

  const search = targetSearchParams.toString();
  const path = `/${encodeURIComponent(workspaceSlug)}${subpath}`;
  return search ? `${path}?${search}` : path;
}
