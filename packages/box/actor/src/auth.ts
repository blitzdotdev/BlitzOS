import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { asJsonObject, isNumber, isString, type JsonValue } from "./type-guards.js";

export type ConnectionRole = "owner" | "admin" | "editor" | "viewer";

export interface ConnectionIdentity {
  userId: string;
  name?: string;
  membershipId: string;
  role: ConnectionRole;
}

interface TicketClaims extends ConnectionIdentity {
  workspaceId: string;
  exp: number;
}

function isConnectionRole(value: JsonValue | undefined): value is ConnectionRole {
  return value === "owner" || value === "admin" || value === "editor" || value === "viewer";
}

function claimsFromJson(value: JsonValue): TicketClaims | null {
  const record = asJsonObject(value);
  if (record === null) return null;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "exp,membershipId,role,userId,workspaceId") return null;
  if (
    !isString(record.workspaceId)
    || !isString(record.userId)
    || !isString(record.membershipId)
    || !isNumber(record.exp)
    || !Number.isSafeInteger(record.exp)
    || !isConnectionRole(record.role)
  ) return null;
  return {
    workspaceId: record.workspaceId,
    userId: record.userId,
    membershipId: record.membershipId,
    role: record.role,
    exp: record.exp,
  };
}

function exactStaticCredential(candidate: string, expected: string): boolean {
  const candidateMac = createHmac("sha256", candidate).update("static-token-compatibility-check").digest();
  const expectedMac = createHmac("sha256", expected).update("static-token-compatibility-check").digest();
  return timingSafeEqual(candidateMac, expectedMac);
}

export class ActorAuthenticator {
  public constructor(
    private readonly tokenPath = "/var/lib/blitz/webapp-token",
    private readonly workspaceIdPath = "/var/lib/blitz/workspace-id",
    private readonly now = () => Math.floor(Date.now() / 1_000),
  ) {}

  public verify(header: string | string[] | undefined): ConnectionIdentity | null {
    if (!isString(header) || header === "") return null;
    let secret: string;
    try {
      secret = readFileSync(this.tokenPath, "utf8").trim();
    } catch {
      return null;
    }
    if (secret === "") return null;
    if (!header.startsWith("v1.")) {
      // TODO(identity-phase-4): Remove static-token acceptance after every box image is re-pinned.
      return exactStaticCredential(header, secret)
        ? { userId: "legacy-owner", name: "Legacy owner", membershipId: "legacy-owner", role: "owner" }
        : null;
    }
    let workspaceId: string;
    try {
      workspaceId = readFileSync(this.workspaceIdPath, "utf8").trim();
    } catch {
      return null;
    }
    const parts = header.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || workspaceId === "") return null;
    const signature = Buffer.from(parts[2] ?? "", "base64url");
    const expected = createHmac("sha256", secret).update(`v1.${parts[1]}`).digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const claims = claimsFromJson(parsed);
    if (claims === null || claims.exp <= this.now() || claims.workspaceId !== workspaceId) return null;
    return {
      userId: claims.userId,
      membershipId: claims.membershipId,
      role: claims.role,
    };
  }
}
