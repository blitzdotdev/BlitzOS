import type { CatalogEntryView } from '@blitzos/schema';

/** How one provider connects, read off the catalog view and never off its
 * name. Four kinds, and every surface that offers a provider prints the word
 * for the one it is:
 *
 * - `oauth`  — a round trip this instance has a client registered for.
 * - `token`  — the member pastes a key. Reported only where no round trip is
 *              live, which is `personalTokenFallbackOnly`'s rule stated once:
 *              a provider never offers two ways in at the same time.
 * - `admin`  — org custody: one key for everyone, stored by an admin.
 * - `none`   — neither path is open here, which is a state, not an action.
 *
 * The first two are paths a member can walk alone; the last two are somebody
 * else's job, and a surface that offers them a button is lying.
 */
export type ConnectMethodKind = 'oauth' | 'token' | 'admin' | 'none';

export interface ConnectMethod {
  kind: ConnectMethodKind;
  /** What a tile says about the provider, in the catalog's own terms. */
  label: string;
}

export function connectMethod(entry: CatalogEntryView): ConnectMethod {
  if (entry.oauthAvailable && entry.oauthConfigured) return { kind: 'oauth', label: 'Connect' };
  if (entry.personalTokenLabel !== null) return { kind: 'token', label: 'Paste a token' };
  if (entry.adminForm !== null) return { kind: 'admin', label: 'Admin sets this up' };
  return { kind: 'none', label: 'Not configured here' };
}

/** Whether the member can authorize this provider on their own account. An
 * unknown provider — an agent asked for a name the catalog does not hold —
 * has no path at all. */
export function hasMemberPath(entry: CatalogEntryView | null): boolean {
  if (entry === null) return false;
  const kind = connectMethod(entry).kind;
  return kind === 'oauth' || kind === 'token';
}
