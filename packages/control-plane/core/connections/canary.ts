import { fetchBoundedText } from "../compute/json-fetch.js";
import { isRecord, isString, type JsonValue } from "../http.js";
import type { CoreRuntime } from "../runtime.js";
import { CATALOG } from "./catalog/index.js";
import type { ProviderManifest } from "./catalog/types.js";
import { recordProviderHealth } from "./health.js";
import { refreshedAccessToken } from "./minters/oauth.js";
import type { GrantRow } from "./user-grants.js";
import {
  grantConfig,
  grantsForProvider,
  openGrantSecret,
} from "./user-grants.js";

/** Grants an operator marks for the canary. §1's escape hatch is a bot user
 * with its own grants; labelling them is all the configuration the cron needs,
 * so an instance with no canary user simply never probes. */
export const CANARY_GRANT_LABEL = "canary";

export interface ProbeOutcome {
  healthy: boolean;
  detail: string | null;
}

function jsonField(value: JsonValue, path: string): string | null {
  let cursor: JsonValue | undefined = value;
  for (const segment of path.split(".")) {
    if (cursor === undefined || !isRecord(cursor)) return null;
    cursor = cursor[segment];
  }
  return cursor !== undefined && isString(cursor) && cursor.length > 0 ? cursor : null;
}

/** Pure so the conformance suite replays recorded probe answers. The detail
 * names the status and the missing field only — never any part of the body. */
export function evaluateProbe(
  manifest: ProviderManifest,
  status: number,
  body: string | null,
): ProbeOutcome {
  const expected = manifest.probe.expect;
  // Every catalog probe is built to answer 200 when healthy; providers whose
  // failure also answers 200 (Linear) declare jsonFields to tell them apart.
  if (status !== 200) {
    return { healthy: false, detail: `status ${String(status)}` };
  }
  if (expected.jsonFields.length === 0) return { healthy: true, detail: null };
  if (body === null) return { healthy: false, detail: "empty response" };
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { healthy: false, detail: "non-JSON response" };
  }
  for (const path of expected.jsonFields) {
    if (jsonField(parsed, path) === null) {
      return { healthy: false, detail: `missing ${path}` };
    }
  }
  return { healthy: true, detail: null };
}

async function canaryToken(
  runtime: CoreRuntime,
  manifest: ProviderManifest,
  grant: GrantRow,
): Promise<string | null> {
  if (grant.kind === "pat") {
    return openGrantSecret(runtime.credentialMasterKey, grant, "refresh");
  }
  const auth = manifest.auth;
  if (auth === null) return null;
  const clientId = runtime.vars.connectSecret(auth.clientIdVar);
  const clientSecret = runtime.vars.connectSecret(auth.clientSecretVar);
  if (clientId === undefined || clientSecret === undefined) return null;
  const access = await refreshedAccessToken(
    {
      db: runtime.db,
      key: runtime.credentialMasterKey,
      clientId,
      clientSecret,
      redirectUri: null,
    },
    { ...manifest, auth },
    grant,
  );
  return access?.accessToken ?? null;
}

async function probeProvider(
  runtime: CoreRuntime,
  manifest: ProviderManifest,
  grant: GrantRow,
): Promise<{ outcome: ProbeOutcome; latencyMs: number | null }> {
  const token = await canaryToken(runtime, manifest, grant);
  if (token === null) {
    // No latency to report: nothing was sent. Zero would read as an
    // instantaneous vendor, which is the opposite of what happened.
    return { outcome: { healthy: false, detail: "no usable token" }, latencyMs: null };
  }
  const config = grantConfig(grant);
  const request = manifest.probe.request({
    token,
    baseUrl: config.baseUrl ?? manifest.baseUrl,
    header: grant.kind === "pat" ? config.tokenHeader : manifest.tokenHeader,
  });
  const headers = new Headers();
  for (const header of request.headers) headers.set(header.name, header.value);
  const started = Date.now();
  try {
    const { response, body } = await fetchBoundedText(
      fetch,
      request.url,
      { method: request.method, headers, body: request.body },
      {
        responseLabel: `${manifest.id} probe`,
        bodyDisposition: () => "read",
      },
    );
    return {
      outcome: evaluateProbe(manifest, response.status, body),
      latencyMs: Date.now() - started,
    };
  } catch {
    // The vendor's own error text can carry account data; the fact of the
    // failure is the whole signal this table is allowed to keep.
    return {
      outcome: { healthy: false, detail: "probe request failed" },
      latencyMs: Date.now() - started,
    };
  }
}

/** Mint-shaped health, once per cron tick: take the canary principal's grant
 * for each catalog provider, make one cheap authenticated call, and write the
 * verdict. Always-on live-prod regression with no external infrastructure. */
export async function runProviderCanary(
  runtime: CoreRuntime,
  now = Date.now(),
): Promise<number> {
  let checked = 0;
  for (const manifest of CATALOG) {
    const grant = (await grantsForProvider(runtime.db, manifest.id))
      .find(({ label }) => label === CANARY_GRANT_LABEL);
    if (grant === undefined) continue;
    const { outcome, latencyMs } = await probeProvider(runtime, manifest, grant);
    await recordProviderHealth(
      runtime.db,
      {
        provider: manifest.id,
        healthy: outcome.healthy,
        detail: outcome.detail,
        latencyMs,
      },
      now,
    );
    checked += 1;
  }
  return checked;
}
