import { gatewayEndpointUrl } from '../preview';

/** The box gateway route that runs `blitz-cred sync` on demand. */
export function credentialSyncEndpointUrl(filesBase: string): string {
  return gatewayEndpointUrl(filesBase, 'credentials/sync');
}

/** Tells the box to fetch its credentials now.
 *
 * Credentials are pull-only: a box syncs from login shells and throttles that
 * on a freshness window, so nothing told it that a member had just connected
 * a provider. In the repro the member watched a connected provider stay dark
 * for the better part of an hour. This is the push that closes that window.
 *
 * Best-effort on purpose. The box's own sync is still the guarantee, an older
 * box image has no such route, and the panel's lease poll shows the truth
 * either way — so a failure here is silence, never an error the person has to
 * read and cannot act on.
 */
export async function pushCredentialSync(
  filesBase: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(credentialSyncEndpointUrl(filesBase), {
      method: 'POST',
      credentials: 'include',
    });
    return response.ok;
  } catch {
    return false;
  }
}
