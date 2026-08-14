import { hashSecret, randomToken } from "../../crypto.js";
import { HttpError, isRecord } from "../../http.js";
import type {
  Integration,
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
    throw new Error("static integration config is invalid");
  }
  if (!isRecord(value) || !Array.isArray(value.placements)) {
    throw new Error("static integration config requires placements");
  }
  return value.placements.map((placement) => {
    if (!isRecord(placement)) throw new Error("static placement is invalid");
    if (
      placement.kind === "env" &&
      typeof placement.name === "string" &&
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
      typeof placement.path === "string" &&
      placement.path.length > 0 &&
      (placement.mode === undefined ||
        (Number.isSafeInteger(placement.mode) &&
          typeof placement.mode === "number" &&
          placement.mode >= 0 &&
          placement.mode <= 0o777)) &&
      (placement.fill === undefined ||
        placement.fill === "token" ||
        placement.fill === "proxy-url")
    ) {
      return {
        kind: "file",
        path: placement.path,
        value: placement.fill === "proxy-url" ? proxyUrl : token,
        ...(placement.mode === undefined ? {} : { mode: placement.mode }),
      };
    }
    if (
      placement.kind === "unset-env" &&
      typeof placement.name === "string" &&
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
    integration: Integration,
    request: MintRequest,
  ): Promise<MinterResult> {
    if (root === null) throw new HttpError(409, "integration has no active root");
    if (integration.custody === "proxy") {
      const token = randomToken();
      return {
        integration: integration.name,
        mode: "proxy",
        placements: staticPlacements(
          integration.config,
          token,
          `${request.origin}/proxy/${request.leaseId}`,
        ),
        expiresAt: request.now + STATIC_LEASE_MS,
        tokenHash: await hashSecret(token),
      };
    }
    if (integration.custody !== "cp") {
      throw new HttpError(409, "static mint requires cp or proxy custody");
    }
    return {
      integration: integration.name,
      mode: "inject",
      placements: staticPlacements(integration.config, root, root),
      expiresAt: request.now + STATIC_LEASE_MS,
    };
  },
};
