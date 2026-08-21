import { hashSecret, randomToken } from "../../crypto.js";
import { HttpError, isNumber, isRecord, isString } from "../../http.js";
import type {
  Connection,
  Minter,
  MintRequest,
  MinterResult,
  Placement,
} from "../types.js";

const STATIC_LEASE_MS = 60 * 60 * 1000;

function staticPlacements(
  configText: string,
  token: string,
  proxyUrl: string,
): Placement[] {
  let value: unknown;
  try {
    value = JSON.parse(configText);
  } catch {
    throw new Error("static connection config is invalid");
  }
  if (!isRecord(value) || !Array.isArray(value.placements)) {
    throw new Error("static connection config requires placements");
  }
  return value.placements.map((placement) => {
    if (!isRecord(placement)) throw new Error("static placement is invalid");
    if (
      placement.kind === "env" &&
      isString(placement.name) &&
      placement.name.length > 0 &&
      (placement.fill === undefined ||
        placement.fill === "token" ||
        placement.fill === "proxy-url")
    ) {
      return {
        kind: "env",
        name: placement.name,
        value: placement.fill === "proxy-url" ? proxyUrl : token,
      };
    }
    if (
      placement.kind === "file" &&
      isString(placement.path) &&
      placement.path.length > 0 &&
      (placement.mode === undefined ||
        (Number.isSafeInteger(placement.mode) &&
          isNumber(placement.mode) &&
          placement.mode >= 0 &&
          placement.mode <= 0o777)) &&
      (placement.fill === undefined ||
        placement.fill === "token" ||
        placement.fill === "proxy-url")
    ) {
      const result: Placement = {
        kind: "file",
        path: placement.path,
        value: placement.fill === "proxy-url" ? proxyUrl : token,
      };
      if (placement.mode !== undefined) result.mode = placement.mode;
      return result;
    }
    if (
      placement.kind === "unset-env" &&
      isString(placement.name) &&
      placement.name.length > 0
    ) {
      return { kind: "unset-env", name: placement.name };
    }
    throw new Error("static placement is invalid");
  });
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
    if (connection.custody === "proxy") {
      const token = randomToken();
      return {
        // FROZEN box wire key: the shipped broker requires "integration".
        integration: connection.name,
        mode: "proxy",
        placements: staticPlacements(
          connection.config,
          token,
          `${request.origin}/proxy/${request.leaseId}`,
        ),
        expiresAt: request.now + STATIC_LEASE_MS,
        tokenHash: await hashSecret(token),
      };
    }
    if (connection.custody !== "cp") {
      throw new HttpError(409, "static mint requires cp or proxy custody");
    }
    return {
      // FROZEN box wire key: the shipped broker requires "integration".
      integration: connection.name,
      mode: "inject",
      placements: staticPlacements(connection.config, root, root),
      expiresAt: request.now + STATIC_LEASE_MS,
    };
  },
};
