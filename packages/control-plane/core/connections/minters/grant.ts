import { hashSecret, randomToken } from "../../crypto.js";
import { HttpError } from "../../http.js";
import { compileSurfaces } from "../catalog/surfaces.js";
import type { ProviderManifest } from "../catalog/types.js";
import type { GrantConfig, GrantRow } from "../user-grants.js";
import { grantCustody, grantOverrides } from "../user-grants.js";
import type { Connection, MinterResult, MintRequest } from "../types.js";

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
  scopes: string[];
}

function leaseExpiry(input: GrantMintInput): number {
  if (input.grant.kind === "pat" || input.grant.access_expires_at === null) {
    return input.request.now + PAT_LEASE_MS;
  }
  // The lease dies with the token it carries; a box holding a dead access
  // token and a live lease is the one state the sync cadence cannot repair.
  return input.grant.access_expires_at;
}

/** Mints from a personal grant. Proxy custody leaves only a per-workspace
 * lease token in the box; `cp` custody is the exception for providers whose
 * own tooling talks to the vendor directly. */
export async function mintFromGrant(
  input: GrantMintInput,
): Promise<MinterResult> {
  const custody = grantCustody(input.manifest, input.config);
  const overrides = grantOverrides(input.manifest, input.config);
  const expiresAt = leaseExpiry(input);
  if (expiresAt <= input.request.now) {
    throw new HttpError(409, "connection grant needs re-authorization");
  }
  if (custody === "proxy") {
    const token = randomToken();
    return {
      // FROZEN box wire key: the shipped broker requires "integration".
      integration: input.connection.name,
      mode: "proxy",
      placements: compileSurfaces(input.manifest, {
        connection: input.connection.name,
        scopes: input.scopes,
        mode: "proxy",
        token,
        proxyUrl: `${input.request.origin}/proxy/${input.request.leaseId}`,
        // Inbound shape only: the proxy re-signs with the grant's own header
        // before the call leaves the control plane.
        tokenHeader: input.manifest.tokenHeader,
        overrides,
      }),
      expiresAt,
      grantedScopes: input.scopes,
      tokenHash: await hashSecret(token),
    };
  }
  if (custody !== "cp") {
    throw new HttpError(409, "grant mint requires cp or proxy custody");
  }
  return {
    // FROZEN box wire key: the shipped broker requires "integration".
    integration: input.connection.name,
    mode: "inject",
    placements: compileSurfaces(input.manifest, {
      connection: input.connection.name,
      scopes: input.scopes,
      mode: "inject",
      token: input.secret,
      proxyUrl: `${input.request.origin}/proxy/${input.request.leaseId}`,
      tokenHeader: input.config.tokenHeader,
      overrides,
    }),
    expiresAt,
    grantedScopes: input.scopes,
  };
}
