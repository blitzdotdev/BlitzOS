/**
 * Build a GitHub owner (user or org) avatar URL from just the handle —
 * no auth, no API call.
 *
 * Host choice is load-bearing. We use `avatars.githubusercontent.com/<handle>`
 * and deliberately NOT `github.com/<handle>.png`:
 *
 *   - `github.com/<handle>.png` answers with a 302 to the avatars host
 *     whose redirect carries NO `Access-Control-Allow-Origin`. A
 *     CORS-mode `fetch()` (how `avatar-cache` persists the blob) fails on
 *     that redirect, so the avatar can never be cached — it re-hits the
 *     network on every render and disappears on a poor connection.
 *   - `avatars.githubusercontent.com/<handle>` answers directly (200,
 *     `Access-Control-Allow-Origin: *`), so it IS CORS-fetchable and the
 *     blob cache (see `CachedAvatarImg`) can make it survive offline.
 *
 * Keep this returning a CORS-fetchable host; switching back to a
 * redirecting one silently re-breaks avatar caching.
 */
export function getGitHubOwnerAvatarUrl(ownerHandle: string): string {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(ownerHandle)}?size=80`;
}
