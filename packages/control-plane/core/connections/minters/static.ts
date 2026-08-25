import { hashSecret, randomToken } from "../../crypto.js";
import { HttpError, isRecord, isString } from "../../http.js";
import type {
  Connection,
  ConnectionEnv,
  Minter,
  MintRequest,
  MinterResult,
  TokenHeader,
} from "../types.js";

const STATIC_LEASE_MS = 60 * 60 * 1000;

/** What an org row that never declared a header sends. Every admin form in the
 * catalog compiles to this pair, so it is the shape a stored row means when it
 * says nothing. */
const DEFAULT_HEADER: TokenHeader = { name: "Authorization", prefix: "Bearer " };

/** An org row's stored config, parsed. The row is D1 text an admin wrote
 * through `PUT /connections/:name`, so it is external data and gets a named
 * type here rather than being read field by field at each use. */
interface StaticConfig {
  /** One environment name per entry, and what fills it. */
  env: readonly { name: string; fill: "token" | "proxy-url" }[];
  header: TokenHeader;
}

function staticConfig(configText: string): StaticConfig {
  let value: unknown;
  try {
    value = JSON.parse(configText);
  } catch {
    throw new Error("static connection config is invalid");
  }
  if (!isRecord(value)) throw new Error("static connection config is invalid");
  if (!Array.isArray(value.placements)) {
    throw new Error("static connection config requires placements");
  }
  const env = value.placements.map((placement) => {
    if (!isRecord(placement) || placement.kind !== "env" || !isString(placement.name)
      || placement.name.length === 0) {
      throw new Error("static placement is invalid");
    }
    // Matched positively, because an inequality against a literal cannot
    // narrow the `string` a stored JSON document may hold.
    if (placement.fill === "proxy-url") {
      return { name: placement.name, fill: "proxy-url" as const };
    }
    if (placement.fill !== undefined && placement.fill !== "token") {
      throw new Error("static placement is invalid");
    }
    return { name: placement.name, fill: "token" as const };
  });
  return { env, header: staticHeader(value.proxy) };
}

/** The header a proxy-custody row declares for its own inbound call. A cp row
 * hands the vendor credential straight over, so its header is the vendor's. */
function staticHeader(proxy: unknown): TokenHeader {
  if (!isRecord(proxy)) return DEFAULT_HEADER;
  return {
    name: isString(proxy.token_header) ? proxy.token_header : DEFAULT_HEADER.name,
    prefix: isString(proxy.token_prefix) ? proxy.token_prefix : DEFAULT_HEADER.prefix,
  };
}

function staticEnv(
  config: StaticConfig,
  token: string,
  proxyUrl: string,
): ConnectionEnv[] {
  return config.env.map(({ name, fill }) => ({
    name,
    value: fill === "proxy-url" ? proxyUrl : token,
  }));
}

export const staticMinter: Minter = {
  kind: "static",
  async mint(
    root: string | null,
    connection: Connection,
    request: MintRequest,
  ): Promise<MinterResult> {
    // FROZEN box-route error text: the string predates the connection rename.
    if (root === null) throw new HttpError(409, "integration has no active root");
    const config = staticConfig(connection.config);
    if (connection.custody === "proxy") {
      const token = randomToken();
      return {
        connection: connection.name,
        mode: "proxy",
        token,
        env: staticEnv(config, token, `${request.origin}/proxy/${request.leaseId}`),
        header: config.header,
        expiresAt: request.now + STATIC_LEASE_MS,
        tokenHash: await hashSecret(token),
      };
    }
    if (connection.custody !== "cp") {
      throw new HttpError(409, "static mint requires cp or proxy custody");
    }
    return {
      connection: connection.name,
      mode: "inject",
      token: root,
      env: staticEnv(config, root, root),
      header: config.header,
      expiresAt: request.now + STATIC_LEASE_MS,
    };
  },
};
