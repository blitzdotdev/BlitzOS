import { HttpError, isRecord, isString } from "../../../http.js";
import type {
  Connection,
  ConnectionEnv,
  Minter,
  MintRequest,
  MinterResult,
} from "../../types.js";

const JWT_TTL_SECONDS = 9 * 60;

interface EnvTemplate {
  kind: "env";
  name: string;
}

interface GithubAppConfig {
  app_id: string;
  installation_id: string;
  repositories?: string[];
  permissions?: Record<string, string>;
  placements?: EnvTemplate[];
}

interface GithubTokenRequestBody {
  repositories?: string[];
  permissions?: Record<string, string>;
}

const PKCS8_PEM =
  /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/u;
const PKCS1_PEM =
  /^-----BEGIN RSA PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END RSA PRIVATE KEY-----$/u;

function decodePrivateKeyPem(value: string): Uint8Array {
  const match = PKCS8_PEM.exec(value.trim());
  if (match?.[1] === undefined) throw new Error("private key is not PKCS#8 PEM");
  let decoded: string;
  try {
    decoded = atob(match[1].replace(/\s/gu, ""));
  } catch {
    throw new Error("private key is not PKCS#8 PEM");
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

/** Minimal DER length octets: one byte below 0x80, else a length-of-length
 * byte followed by the big-endian length. */
function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.trunc(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** The PEM the importer gets. GitHub downloads App keys as PKCS#1
 * (`BEGIN RSA PRIVATE KEY`), WebCrypto imports only PKCS#8, so a PKCS#1
 * armor is re-wrapped here and everything else passes through for
 * `importGithubAppPrivateKey` to judge. Encrypted keys throw the one
 * caller-facing distinction: no wrap can fix a passphrase.
 *
 * SAFETY of the hand-rolled DER: PKCS#8 PrivateKeyInfo (RFC 5208) for an
 * unencrypted RSA key is exactly
 *   SEQUENCE {
 *     INTEGER 0,                            -- version, bytes 02 01 00
 *     SEQUENCE { OID rsaEncryption, NULL }, -- the fixed 15 bytes below
 *     OCTET STRING <PKCS#1 RSAPrivateKey>   -- the decoded body, verbatim
 *   }
 * Only the two outer lengths depend on the input and `derLength` emits
 * minimal DER lengths, so the wrap is deterministic. Whether the blob really
 * is an RSAPrivateKey stays importKey's decision, made right after. The
 * conformance test wraps a generated key, byte-compares against WebCrypto's
 * own PKCS#8 export, and signs with the imported result. */
export function normalizeGithubAppPrivateKey(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.includes("BEGIN ENCRYPTED PRIVATE KEY") ||
    trimmed.includes("Proc-Type: 4,ENCRYPTED")
  ) {
    throw new HttpError(
      400,
      "the private key is encrypted; upload the unencrypted .pem file GitHub generated",
    );
  }
  const match = PKCS1_PEM.exec(trimmed);
  if (match?.[1] === undefined) return value;
  const decoded = atob(match[1].replace(/\s/gu, ""));
  const pkcs1 = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const rsaEncryption = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  );
  const body = concatBytes(
    Uint8Array.of(0x02, 0x01, 0x00),
    rsaEncryption,
    Uint8Array.of(0x04),
    derLength(pkcs1.byteLength),
    pkcs1,
  );
  const wrapped = concatBytes(
    Uint8Array.of(0x30),
    derLength(body.byteLength),
    body,
  );
  let binary = "";
  for (const byte of wrapped) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
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

/** Exported for the repository-listing route (`github-repos.ts`), which
 * mints its own short-lived installation token instead of duplicating the
 * RS256 signing here. */
export async function appJwt(
  root: string,
  config: Pick<GithubAppConfig, "app_id">,
  now: number,
): Promise<string> {
  const seconds = Math.floor(now / 1000);
  const encodeJson = <Value>(value: Value): string =>
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
    !isString(parsed.app_id) ||
    !isString(parsed.installation_id)
  ) {
    throw new Error("github app connection config is invalid");
  }
  // SAFETY: app_id and installation_id are strings; optional nested config is not checked. TODO(deslop-tier-c): validate placements, repositories, and permissions before constructing GithubAppConfig.
  return parsed as typeof parsed & GithubAppConfig;
}

function fillEnv(config: GithubAppConfig, token: string): ConnectionEnv[] {
  const templates = config.placements ?? [
    { kind: "env" as const, name: "GH_TOKEN" },
    { kind: "env" as const, name: "GITHUB_TOKEN" },
  ];
  return templates
    .filter((template) => template.kind === "env")
    .map((template) => ({ name: template.name, value: token }));
}

function grantedScopes(value: Record<string, unknown>): string[] {
  const granted: string[] = [];
  if (Array.isArray(value.repositories)) {
    for (const repository of value.repositories) {
      if (isRecord(repository) && isString(repository.name)) {
        granted.push(`repo:${repository.name}`);
      }
    }
  }
  if (isRecord(value.permissions)) {
    for (const [permission, level] of Object.entries(value.permissions)) {
      if (isString(level)) granted.push(`${permission}:${level}`);
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
    connection: Connection,
    request: MintRequest,
  ): Promise<MinterResult> {
    if (connection.custody !== "cp") {
      throw new HttpError(409, "github app mint requires cp custody");
    }
    // FROZEN box-route error text: the string predates the connection rename.
    if (root === null) throw new HttpError(409, "integration has no active root");
    const config = parseConfig(connection.config);
    const body: GithubTokenRequestBody = {};
    if (config.repositories !== undefined) body.repositories = config.repositories;
    if (config.permissions !== undefined) body.permissions = config.permissions;
    // TODO(house-canon): Route this legacy raw request through the canonical fetch boundary.
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
    if (!isRecord(value) || !isString(value.token) || !isString(value.expires_at)) {
      throw new HttpError(502, "github returned an invalid installation token response");
    }
    const expiresAt = Date.parse(value.expires_at);
    if (!Number.isFinite(expiresAt)) {
      throw new HttpError(502, "github returned an invalid installation token response");
    }
    return {
      connection: connection.name,
      mode: "inject",
      token: value.token,
      env: fillEnv(config, value.token),
      header: { name: "Authorization", prefix: "Bearer " },
      expiresAt,
      grantedScopes: grantedScopes(value),
    };
  },
};
