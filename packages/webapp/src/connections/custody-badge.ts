import type { Custody } from '@blitzos/schema';

/** Where the key sits once a credential is minted. The words match what a
 * workspace connection row already prints, so the badge teaches the same
 * vocabulary in both places.
 *
 * It lives in its own module because two unrelated surfaces print it — the
 * workspace provider rows and the org connection list in settings — and
 * neither should have to import a component to get a noun. */
export const CUSTODY_BADGE = {
  cp: 'injected',
  proxy: 'proxied',
} satisfies Record<Custody, string>;
