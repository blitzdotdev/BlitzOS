import { HttpError, isNumber, isRecord, isString, type JsonValue } from "./http.js";

export const WEBAPP_TOKEN_HEADER = "X-Blitz-WebApp-Token";
export const WEBAPP_TICKET_TTL_SECONDS = 60;

export type WebAppRole = "owner" | "admin" | "editor" | "viewer";
export type WebAppSurface = "terminal" | "files" | "chat";

export interface WebAppTicketClaims {
  workspaceId: string;
  userId: string;
  membershipId: string;
  role: WebAppRole;
  surface: WebAppSurface;
  exp: number;
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

function isWebAppRole(value: JsonValue | undefined): value is WebAppRole {
  return value === "owner" || value === "admin" || value === "editor" || value === "viewer";
}

function isWebAppSurface(value: JsonValue | undefined): value is WebAppSurface {
  return value === "terminal" || value === "files" || value === "chat";
}

function parseClaims(value: JsonValue): WebAppTicketClaims | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "exp,membershipId,role,surface,userId,workspaceId") return null;
  if (
    !isString(value.workspaceId)
    || !isString(value.userId)
    || !isString(value.membershipId)
    || !isNumber(value.exp)
    || !Number.isSafeInteger(value.exp)
    || !isWebAppRole(value.role)
    || !isWebAppSurface(value.surface)
  ) return null;
  return {
    workspaceId: value.workspaceId,
    userId: value.userId,
    membershipId: value.membershipId,
    role: value.role,
    surface: value.surface,
    exp: value.exp,
  };
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
    const payload: WebAppTicketClaims = {
      workspaceId: claims.workspaceId,
      userId: claims.userId,
      membershipId: claims.membershipId,
      role: claims.role,
      surface: claims.surface,
      exp: nowSeconds + WEBAPP_TICKET_TTL_SECONDS,
    };
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
    surface: WebAppSurface,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): Promise<VerifiedWebAppCredential | null> {
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
          surface,
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
      || claims.surface !== surface
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
