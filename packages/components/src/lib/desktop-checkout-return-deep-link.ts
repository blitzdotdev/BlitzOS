import { readWorkspaceSlugFromPath } from './deep-link-path';

/**
 * Map a `lody://checkout-return` deep link (fired by the browser-side
 * /desktop/checkout-return page after a Stripe checkout or portal visit)
 * to the in-app billing settings path. Mirrors
 * resolveDesktopGitHubInstallDeepLinkPath.
 */
export function resolveDesktopCheckoutReturnDeepLinkPath(
  deepLinkUrl: string,
  fallbackPathname = '/'
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(deepLinkUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'lody:' || parsed.hostname !== 'checkout-return') {
    return null;
  }

  const workspaceSlug =
    parsed.searchParams.get('workspaceSlug')?.trim() || readWorkspaceSlugFromPath(fallbackPathname);
  if (!workspaceSlug) {
    return null;
  }

  const targetSearchParams = new URLSearchParams();
  const checkout = parsed.searchParams.get('checkout');
  if (checkout === 'success') {
    targetSearchParams.set('checkout', 'success');
  }

  const search = targetSearchParams.toString();
  const path = `/${encodeURIComponent(workspaceSlug)}/settings/billing`;
  return search ? `${path}?${search}` : path;
}
