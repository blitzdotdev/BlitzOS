import { z } from 'zod';
import { requireCloudAuthBaseUrl } from './cloud-http-port';

const VerifyPasswordResponseSchema = z.object({ valid: z.boolean() }).passthrough();

type VerifyCurrentPasswordOptions = {
  sessionToken: string;
  authBaseUrl?: string;
  password: string;
};

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/**
 * Verify the logged-in user's current password server-side (better-auth's
 * verify-password endpoint is server-only, so this hits the Convex proxy at
 * `/api/account/verify-password`). Returns whether the password is correct;
 * throws on transport / auth errors so callers can distinguish "wrong password"
 * from "couldn't check".
 */
export async function verifyCurrentPassword({
  sessionToken,
  authBaseUrl,
  password,
}: VerifyCurrentPasswordOptions): Promise<boolean> {
  authBaseUrl = requireCloudAuthBaseUrl('cloudAccount', authBaseUrl);
  const trimmedToken = sessionToken.trim();
  if (!trimmedToken) {
    throw new Error('not_authenticated');
  }
  if (!authBaseUrl) {
    throw new Error('missing_auth_site_url');
  }

  const response = await fetch(`${trimTrailingSlash(authBaseUrl)}/api/account/verify-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${trimmedToken}`,
    },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    throw new Error(`http_${response.status}`);
  }

  const parsed = VerifyPasswordResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new Error('invalid_response');
  }
  return parsed.data.valid;
}
