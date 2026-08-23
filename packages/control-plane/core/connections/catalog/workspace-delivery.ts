import type { Placement } from "../types.js";
import { manifestBaseUrl } from "./index.js";
import type { DeliveryInput, ProviderManifest } from "./types.js";

/** The shipped box image sets HOME here (packages/box/Dockerfile). File
 * placements are written verbatim — the box does no `~` expansion — so the
 * catalog's home-relative delivery paths are resolved against this constant. */
export const BOX_HOME = "/var/lib/blitz/home";

const SKILL_MODE = 0o600;

/** Inject custody puts the vendor root itself in the box, so a manifest with
 * no fixed root cannot be delivered that way — the skill would print a URL
 * nobody owns. Proxy custody never asks: the lease URL is the root. */
function baseUrlFor(input: DeliveryInput, manifest: ProviderManifest): string {
  if (input.mode === "proxy") return input.proxyUrl;
  return manifestBaseUrl(manifest, "inject-custody delivery");
}

export function skillPath(manifest: ProviderManifest, connection: string): string {
  return `${BOX_HOME}/${manifest.delivery.skill.path.replace("<provider>", connection)}`;
}

/** Everything a lease delivers into the workspace beyond the raw credential,
 * compiled into the frozen `placements` array. `blitz-cred` writes these
 * verbatim — an environment name per entry, plus the provider skill file. No
 * top-level mint-response key is ever added: the shipped box decodes with
 * DisallowUnknownFields. */
export function compileDelivery(
  manifest: ProviderManifest,
  input: DeliveryInput,
): Placement[] {
  const placements: Placement[] = [];
  const baseUrl = baseUrlFor(input, manifest);
  const deliveries = manifest.delivery.env;
  for (const delivery of deliveries) {
    placements.push({
      kind: "env",
      name: delivery.name,
      value: delivery.fill === "proxy-url" ? baseUrl : input.token,
    });
  }
  const tokenEnv = deliveries.find((delivery) => delivery.fill === "token");
  const baseUrlEnv = deliveries.find((delivery) => delivery.fill === "proxy-url");
  placements.push({
    kind: "file",
    path: skillPath(manifest, input.connection),
    value: manifest.delivery.skill.render({
      connection: input.connection,
      scopes: input.scopes,
      mode: input.mode,
      grantKind: input.grantKind,
      tokenEnv: tokenEnv?.name ?? "BLITZ_CONNECTION_TOKEN",
      baseUrlEnv: baseUrlEnv?.name ?? null,
      baseUrl,
      tokenHeader: input.tokenHeader,
    }),
    mode: SKILL_MODE,
  });
  return placements;
}

/** Revocation symmetry, Phase A: the running box image has no `remove-file`
 * placement, so a dead connection's delivery is overwritten empty and its
 * environment names are unset. A stale skill for a dead connection would
 * gaslight the agent into retrying a credential that no longer exists. */
export function tombstoneDelivery(
  manifest: ProviderManifest,
  connection: string,
  environmentNames: readonly string[],
): Placement[] {
  const placements: Placement[] = [];
  for (const name of environmentNames) {
    placements.push({ kind: "unset-env", name });
  }
  placements.push({
    kind: "file",
    path: skillPath(manifest, connection),
    value: "",
    mode: SKILL_MODE,
  });
  return placements;
}
