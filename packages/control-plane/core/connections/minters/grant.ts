import { hashSecret, randomToken } from "../../crypto.js";
import { HttpError } from "../../http.js";
import { manifestBaseUrl } from "../catalog/index.js";
import type { ProviderManifest } from "../catalog/types.js";
import type { GrantConfig, GrantRow } from "../user-grants.js";
import type {
  Connection,
  ConnectionEnv,
  MinterResult,
  MintRequest,
} from "../types.js";

/** A pasted key has no expiry of its own, so its lease keeps the cadence the
 * static minter already set: one hour, re-minted at the next shell login. */
const PAT_LEASE_MS = 60 * 60 * 1_000;

export interface GrantMintInput {
  manifest: ProviderManifest;
  grant: GrantRow;
  config: GrantConfig;
  connection: Connection;
  request: MintRequest;
  /** Already decrypted: the access token for an oauth grant, the pasted key
   * for a personal one. Never persisted by this module. */
  secret: string;
  /** When `secret` dies, or null for a pasted key that has no expiry. This is
   * deliberately not read off `grant`: a refresh on the way in rotates the
   * token and writes a new expiry, and `grant` is the row from before that
   * write — trusting it hands every later mint an already-dead lease. */
  accessExpiresAt: number | null;
  scopes: string[];
}

function leaseExpiry(input: GrantMintInput): number {
  if (input.grant.kind === "pat" || input.accessExpiresAt === null) {
    return input.request.now + PAT_LEASE_MS;
  }
  // The lease dies with the token it carries; a box holding a dead access
  // token and a live lease is the one state the sync cadence cannot repair.
  return input.accessExpiresAt;
}

/** The environment names this provider answers to, filled. Nothing writes
 * them: `blitz-cred env` prints them so an agent can scope a secret to one
 * command. A `proxy-url` entry carries the root the token is good against,
 * which is the lease URL under proxy custody and the vendor's own root
 * otherwise. */
function connectionEnv(
  manifest: ProviderManifest,
  token: string,
  baseUrl: string,
): ConnectionEnv[] {
  return manifest.delivery.env.map((delivery) => ({
    name: delivery.name,
    value: delivery.fill === "proxy-url" ? baseUrl : token,
  }));
}

/** Mints from a personal grant. Proxy custody hands out a per-workspace lease
 * token and keeps the real credential in the control plane; `cp` custody is
 * the exception for providers whose own tooling talks to the vendor directly. */
export async function mintFromGrant(
  input: GrantMintInput,
): Promise<MinterResult> {
  const custody = input.manifest.custody;
  const expiresAt = leaseExpiry(input);
  if (expiresAt <= input.request.now) {
    throw new HttpError(409, "connection grant needs re-authorization");
  }
  if (custody === "proxy") {
    const token = randomToken();
    const proxyUrl = `${input.request.origin}/proxy/${input.request.leaseId}`;
    return {
      connection: input.connection.name,
      mode: "proxy",
      token,
      env: connectionEnv(input.manifest, token, proxyUrl),
      // Inbound shape only: the proxy re-signs with the grant's own header
      // before the call leaves the control plane.
      header: input.manifest.tokenHeader,
      expiresAt,
      grantedScopes: input.scopes,
      tokenHash: await hashSecret(token),
    };
  }
  return {
    connection: input.connection.name,
    mode: "inject",
    token: input.secret,
    env: connectionEnv(
      input.manifest,
      input.secret,
      manifestBaseUrl(input.manifest, "inject-custody mint"),
    ),
    header: input.config.tokenHeader,
    expiresAt,
    grantedScopes: input.scopes,
  };
}
