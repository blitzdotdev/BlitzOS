import { HttpError, isNumber, isRecord, isString, type JsonValue } from "./http.js";
import type { WorkspaceRole } from "./wire.js";

export const WEBAPP_TOKEN_HEADER = "X-Blitz-WebApp-Token";
export const WEBAPP_TICKET_TTL_SECONDS = 60;

/** 2026-08-17 19:10 UTC: the first moment a new Hetzner box booted the
 * ticket-verifying gateway (image 20260817a). A VM keeps the image it booted
 * for life, so anything older only understands the static token. Providers
 * declare their own cutoff — a guest channel that has never shipped ticket
 * verification declares none and always receives the static token. */
export const BOX_IMAGE_TICKETS_SINCE_MS = 1_786_993_800_000;

/** Set when image 20260818a became the pin. Its gateway refuses a terminal
 * request that is not shaped to carry the read-only flag — earlier images
 * appended it as a third argument, which slid it into the session-key slot
 * and quietly restored write access — and its blitz-term will not create a
 * session for an observer. Viewers may only reach VMs booted from it. */
export const BOX_IMAGE_VIEWER_GUARDS_SINCE_MS = 1_787_043_600_000;

/** Set when the first box image whose gateway understands the `share` claim
 * became the pin. An older gateway refuses a ticket carrying it — its decoder
 * disallows unknown fields, which is the property `unknown-claim.json` exists to
 * keep — so the control plane refuses the shared-session route on an older VM
 * with a message that names the fix, rather than letting the box answer a 403
 * nobody can read (plans/LODY-SHARING.md §3.1).
 *
 * 2026-08-30 00:00 UTC, image 20260830a. */
export const BOX_IMAGE_SHARED_SESSIONS_SINCE_MS = 1_788_048_000_000;

/** The most session ids one ticket carries.
 *
 * A ticket rides in a request header and is minted per request; 64 uuid-shaped
 * ids is about 3 KB of header, which is the last size comfortably under every
 * proxy default in the path. A grantee holding more shares on ONE member's
 * machine keeps the 64 most recent (plans/LODY-SHARING.md §3.2). */
export const MAX_TICKET_SHARE_SESSIONS = 64;

/**
 * What a ticket routed to ANOTHER member's machine may do there
 * (plans/LODY-SHARING.md §3.2).
 *
 * Two disjoint id lists rather than one level, because a grantee can hold
 * read-only on one session and read-write on another on the same box. The two
 * ACL predicates then fall out with no branching:
 *
 *   may JOIN   room `doc:session-<id>`  ⟺  scope === "all" || id ∈ read ∪ write
 *   may UPDATE room `doc:session-<id>`  ⟺  id ∈ write
 *
 * The second does not mention `scope`, which is what makes a workspace admin's
 * implicit access read-only BY CONSTRUCTION rather than by a rule somebody has
 * to remember.
 */
export interface WebAppShareClaim {
  /** The membership whose machine this ticket is routed to. */
  target: string;
  /** `"all"` is a workspace admin's implicit read-only over every session on
   * that machine; `"sessions"` is an ordinary grantee. */
  scope: "sessions" | "all";
  /** Session ids this ticket may read. */
  read: string[];
  /** Session ids this ticket may also write. Disjoint from `read`. */
  write: string[];
}

export interface WebAppTicketClaims {
  workspaceId: string;
  userId: string;
  membershipId: string;
  role: WorkspaceRole;
  exp: number;
  /** Absent on every ordinary ticket, which is what keeps those tickets
   * verifiable by every box image in the field. */
  share?: WebAppShareClaim;
}

export type VerifiedWebAppCredential =
  | { kind: "ticket"; claims: WebAppTicketClaims }
  | { kind: "static"; claims: WebAppTicketClaims };

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function isWorkspaceRole(value: JsonValue | undefined): value is WorkspaceRole {
  return value === "owner" || value === "admin" || value === "editor" || value === "viewer";
}

function parseIdList(value: JsonValue | undefined): string[] | null {
  if (value === undefined || !Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (!isString(entry) || entry === "") return null;
    ids.push(entry);
  }
  return ids.length > MAX_TICKET_SHARE_SESSIONS ? null : ids;
}

/** The share claim, checked as an exact key set exactly like the claims around
 * it: a verifier that skips a field it does not know cannot enforce it. */
function parseShare(value: JsonValue | undefined): WebAppShareClaim | null {
  if (value === undefined || !isRecord(value)) return null;
  if (Object.keys(value).sort().join(",") !== "read,scope,target,write") return null;
  if (!isString(value.target) || value.target === "") return null;
  if (value.scope !== "sessions" && value.scope !== "all") return null;
  const read = parseIdList(value.read);
  const write = parseIdList(value.write);
  if (read === null || write === null) return null;
  if (read.length + write.length > MAX_TICKET_SHARE_SESSIONS) return null;
  // Disjoint, so the two ACL predicates cannot disagree about one session.
  if (read.some((id) => write.includes(id))) return null;
  return { target: value.target, scope: value.scope, read, write };
}

function parseClaims(value: JsonValue): WebAppTicketClaims | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const shared = keys.join(",") === "exp,membershipId,role,share,userId,workspaceId";
  if (!shared && keys.join(",") !== "exp,membershipId,role,userId,workspaceId") return null;
  if (
    !isString(value.workspaceId)
    || !isString(value.userId)
    || !isString(value.membershipId)
    || !isNumber(value.exp)
    || !Number.isSafeInteger(value.exp)
    || !isWorkspaceRole(value.role)
  ) return null;
  const claims: WebAppTicketClaims = {
    workspaceId: value.workspaceId,
    userId: value.userId,
    membershipId: value.membershipId,
    role: value.role,
    exp: value.exp,
  };
  if (!shared) return claims;
  const share = parseShare(value.share);
  if (share === null) return null;
  return { ...claims, share };
}

export class WorkspaceWebAppAuth {
  public constructor(private readonly rootSecret: string) {
    if (rootSecret === "") throw new Error("WEBAPP_TOKEN_SECRET is required");
  }

  public async tokenFor(workspaceId: string): Promise<string> {
    const mac = await crypto.subtle.sign(
      "HMAC",
      await hmacKey(this.rootSecret),
      encoder.encode(workspaceId),
    );
    return base64Url(new Uint8Array(mac));
  }

  public async mint(
    claims: Omit<WebAppTicketClaims, "exp">,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): Promise<string> {
    // Built field by field, in the order the fixture corpus encodes, so the
    // signed bytes do not depend on the caller's object literal.
    const payload: WebAppTicketClaims = {
      workspaceId: claims.workspaceId,
      userId: claims.userId,
      membershipId: claims.membershipId,
      role: claims.role,
      exp: nowSeconds + WEBAPP_TICKET_TTL_SECONDS,
    };
    if (claims.share !== undefined) payload.share = claims.share;
    const encodedPayload = base64Url(encoder.encode(JSON.stringify(payload)));
    const signingInput = `v1.${encodedPayload}`;
    const signature = await crypto.subtle.sign(
      "HMAC",
      await hmacKey(await this.tokenFor(claims.workspaceId)),
      encoder.encode(signingInput),
    );
    return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  }

  public async verify(
    credential: string,
    workspaceId: string,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): Promise<VerifiedWebAppCredential | null> {
    // An empty credential is simply absent, not a candidate to compare: Web
    // Crypto refuses a zero-length HMAC key and would throw where every other
    // rejection returns null.
    if (credential === "") return null;
    const workspaceToken = await this.tokenFor(workspaceId);
    if (!credential.startsWith("v1.")) {
      // TODO(identity-phase-4): Remove static-token acceptance after every box image is re-pinned with ticket verification.
      const candidateMac = await crypto.subtle.sign(
        "HMAC",
        await hmacKey(credential),
        encoder.encode("static-token-compatibility-check"),
      );
      if (!await crypto.subtle.verify(
        "HMAC",
        await hmacKey(workspaceToken),
        candidateMac,
        encoder.encode("static-token-compatibility-check"),
      )) return null;
      return {
        kind: "static",
        claims: {
          workspaceId,
          userId: "legacy-owner",
          membershipId: "legacy-owner",
          role: "owner",
          exp: Number.MAX_SAFE_INTEGER,
        },
      };
    }
    const parts = credential.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return null;
    const payloadBytes = decodeBase64Url(parts[1] ?? "");
    const signature = decodeBase64Url(parts[2] ?? "");
    if (payloadBytes === null || signature === null) return null;
    if (!await crypto.subtle.verify(
      "HMAC",
      await hmacKey(workspaceToken),
      signature,
      encoder.encode(`v1.${parts[1]}`),
    )) return null;
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
    } catch {
      return null;
    }
    const claims = parseClaims(parsed);
    if (
      claims === null
      || claims.exp <= nowSeconds
      || claims.workspaceId !== workspaceId
    ) return null;
    return { kind: "ticket", claims };
  }
}

export function workspaceWebAppAuthFromEnv(
  env: { WEBAPP_TOKEN_SECRET?: string },
): WorkspaceWebAppAuth | undefined {
  const secret = env.WEBAPP_TOKEN_SECRET ?? "";
  return secret === "" ? undefined : new WorkspaceWebAppAuth(secret);
}

export function requireWorkspaceWebAppAuth(
  auth: WorkspaceWebAppAuth | undefined,
): WorkspaceWebAppAuth {
  if (auth === undefined) throw new HttpError(503, "workspace webApp authentication is unavailable");
  return auth;
}
