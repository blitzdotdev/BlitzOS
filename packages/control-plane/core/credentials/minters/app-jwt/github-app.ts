import { HttpError, isRecord } from "../../../http.js";
import type {
  Integration,
  Minter,
  MintRequest,
  MintResult,
  Placement,
} from "../../types.js";

const JWT_TTL_SECONDS = 9 * 60;

type PlacementTemplate =
  | { kind: "env"; name: string }
  | { kind: "file"; path: string; mode?: number }
  | { kind: "unset-env"; name: string };

interface GithubAppConfig {
  app_id: string;
  installation_id: string;
  repositories?: string[];
  permissions?: Record<string, string>;
  placements?: PlacementTemplate[];
}

function decodePrivateKeyPem(value: string): Uint8Array {
  const match = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/u.exec(
    value.trim(),
  );
  if (match?.[1] === undefined) throw new Error("private key is not PKCS#8 PEM");
  let decoded: string;
  try {
    decoded = atob(match[1].replace(/\s/gu, ""));
  } catch {
    throw new Error("private key is not PKCS#8 PEM");
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export async function importGithubAppPrivateKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    decodePrivateKeyPem(value),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

async function appJwt(root: string, config: GithubAppConfig, now: number): Promise<string> {
  const seconds = Math.floor(now / 1000);
  const encodeJson = (value: unknown): string =>
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const payload = encodeJson({
    iat: seconds - 60,
    exp: seconds + JWT_TTL_SECONDS,
    iss: config.app_id,
  });
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importGithubAppPrivateKey(root),
    new TextEncoder().encode(input),
  );
  return `${input}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function parseConfig(value: string): GithubAppConfig {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    typeof parsed.app_id !== "string" ||
    typeof parsed.installation_id !== "string"
  ) {
    throw new Error("github app integration config is invalid");
  }
  return parsed as unknown as GithubAppConfig;
}

function fillPlacements(config: GithubAppConfig, token: string): Placement[] {
  const templates = config.placements ?? [
    { kind: "env" as const, name: "GH_TOKEN" },
    { kind: "env" as const, name: "GITHUB_TOKEN" },
  ];
  return templates.map((placement) => {
    if (placement.kind === "env") return { ...placement, value: token };
    if (placement.kind === "file") return { ...placement, value: token };
    return placement;
  });
}

function grantedScopes(value: Record<string, unknown>): string[] {
  const granted: string[] = [];
  if (Array.isArray(value.repositories)) {
    for (const repository of value.repositories) {
      if (isRecord(repository) && typeof repository.name === "string") {
        granted.push(`repo:${repository.name}`);
      }
    }
  }
  if (isRecord(value.permissions)) {
    for (const [permission, level] of Object.entries(value.permissions)) {
      if (typeof level === "string") granted.push(`${permission}:${level}`);
    }
  }
  return granted;
}

function vendorError(status: number): HttpError {
  if (status === 401) {
    return new HttpError(502, "github rejected the app JWT (key or clock)");
  }
  if (status === 404) {
    return new HttpError(502, "github installation not found");
  }
  return new HttpError(502, `github access token request failed with status ${status}`);
}

export const githubAppMinter: Minter = {
  kind: "app-jwt",
  providers: ["github"],
  async mint(
    root: string | null,
    integration: Integration,
    request: MintRequest,
  ): Promise<MintResult> {
    if (integration.custody !== "cp") {
      throw new HttpError(409, "github app mint requires cp custody");
    }
    if (root === null) throw new HttpError(409, "integration has no active root");
    const config = parseConfig(integration.config);
    const body: Record<string, unknown> = {};
    if (config.repositories !== undefined) body.repositories = config.repositories;
    if (config.permissions !== undefined) body.permissions = config.permissions;
    const response = await fetch(
      `https://api.github.com/app/installations/${config.installation_id}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${await appJwt(root, config, request.now)}`,
          "Content-Type": "application/json",
          "User-Agent": "blitz-control-plane",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw vendorError(response.status);
    const value: unknown = await response.json();
    if (!isRecord(value) || typeof value.token !== "string" || typeof value.expires_at !== "string") {
      throw new HttpError(502, "github returned an invalid installation token response");
    }
    const expiresAt = Date.parse(value.expires_at);
    if (!Number.isFinite(expiresAt)) {
      throw new HttpError(502, "github returned an invalid installation token response");
    }
    return {
      integration: integration.name,
      mode: "inject",
      placements: fillPlacements(config, value.token),
      expiresAt,
      grantedScopes: grantedScopes(value),
    };
  },
};
