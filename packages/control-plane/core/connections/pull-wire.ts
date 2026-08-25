import {
  HttpError,
  isNumber,
  isRecord,
  isString,
  type JsonObject,
  type JsonValue,
} from "../http.js";
import type { ConnectionEnv, MintResult, TokenHeader } from "./types.js";

/** What a provider name may contain. The box puts this in a URL path segment
 * and prints it back, so the two sides agree on the alphabet. */
const CONNECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** A shell identifier. `blitz-cred env` prints `NAME='value'` for an agent to
 * eval, so a name outside this is not a variable assignment. */
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A header name, as HTTP allows it. */
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*$/u;

/** Every key the wire carries, sorted, as one comparable string. */
const MINT_RESULT_KEYS = "connection,env,expiresAt,header,mode,token";

/** The box prints these bytes. `blitz-cred get` writes the token on stdout and
 * `blitz-cred env` writes a header comment line then assignment lines. A
 * carriage return or newline ends one of those lines early, so the rest reads
 * as a statement the control plane never sent. NUL cannot cross execve at all.
 *
 * This runs on the producer for a reason: a vendor token that carried a
 * newline used to reach the box, which then answered "invalid credential mint
 * response" and told nobody which provider or why. */
function printable(value: string): boolean {
  return !/[\r\n\0]/u.test(value);
}

function invalid(field: string): never {
  throw new HttpError(502, `credential mint produced an unusable ${field}`);
}

function parseHeader(value: JsonValue | undefined): TokenHeader {
  if (!isRecord(value) || !isString(value.name) || !isString(value.prefix)) {
    invalid("header");
  }
  if (!HEADER_NAME.test(value.name) || !printable(value.prefix)) invalid("header");
  return { name: value.name, prefix: value.prefix };
}

function parseEnv(value: JsonValue | undefined): ConnectionEnv[] {
  if (!Array.isArray(value)) invalid("env list");
  return value.map((entry) => {
    if (!isRecord(entry) || !isString(entry.name) || !isString(entry.value)) {
      invalid("env entry");
    }
    if (!ENVIRONMENT_NAME.test(entry.name) || !printable(entry.value)) {
      invalid("env entry");
    }
    return { name: entry.name, value: entry.value };
  });
}

/** The last gate before a credential leaves the control plane.
 *
 * The box decodes this body with DisallowUnknownFields and refuses anything it
 * cannot print, so a body that fails here would fail there — with a message
 * that names no provider and no cause. Failing on this side turns that into a
 * 502 an operator can read. */
export function parseMintResult(value: JsonValue): MintResult {
  if (!isRecord(value)) invalid("body");
  // The box decodes with DisallowUnknownFields, so an extra key aborts the
  // pull. `placements` is the old delivery key, and it is exactly the key a
  // half-reverted change would leave here.
  if (Object.keys(value).sort().join(",") !== MINT_RESULT_KEYS) invalid("body");
  const { connection, mode, token, expiresAt } = value;
  if (!isString(connection) || !CONNECTION_NAME.test(connection)) invalid("connection name");
  if (mode !== "inject" && mode !== "proxy") invalid("mode");
  if (!isString(token) || token.length === 0 || !printable(token)) invalid("token");
  if (!isNumber(expiresAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    invalid("expiry");
  }
  return {
    connection,
    mode,
    token,
    env: parseEnv(value.env),
    header: parseHeader(value.header),
    expiresAt,
  };
}

/** The minted credential as JSON, with every wire key named once. It exists so
 * the route can hand a typed result to the parser above without an assertion,
 * and so the key list has exactly one home. */
export function mintResultBody(result: MintResult): JsonObject {
  return {
    connection: result.connection,
    mode: result.mode,
    token: result.token,
    env: result.env.map((entry) => ({ name: entry.name, value: entry.value })),
    header: { name: result.header.name, prefix: result.header.prefix },
    expiresAt: result.expiresAt,
  };
}
