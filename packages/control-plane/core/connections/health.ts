import type { Db } from "../db.js";
import { rows } from "../db.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { CATALOG } from "./catalog/index.js";
import type { ProviderHealthView } from "./types.js";

interface ProviderHealthRow {
  provider: string;
  state: "healthy" | "unhealthy";
  detail: string | null;
  checked_at: number;
  latency_ms: number | null;
}

export interface ProviderHealthRecord {
  provider: string;
  healthy: boolean;
  detail: string | null;
  latencyMs: number | null;
}

export async function recordProviderHealth(
  db: Db,
  record: ProviderHealthRecord,
  now = Date.now(),
): Promise<void> {
  await rows(db, {
    q: `INSERT INTO provider_health (provider, state, detail, checked_at, latency_ms)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(provider) DO UPDATE SET
          state = excluded.state,
          detail = excluded.detail,
          checked_at = excluded.checked_at,
          latency_ms = excluded.latency_ms`,
    v: [
      record.provider,
      record.healthy ? "healthy" : "unhealthy",
      record.detail,
      now,
      record.latencyMs,
    ],
  });
}

/** Every catalog provider appears, checked or not: "unchecked" is an answer
 * the panel needs, and a missing row would read as healthy. */
export async function listProviderHealth(db: Db): Promise<ProviderHealthView[]> {
  const recorded = new Map(
    (await rows<ProviderHealthRow>(db, {
      q: "SELECT provider, state, detail, checked_at, latency_ms FROM provider_health",
      v: [],
    })).map((row) => [row.provider, row]),
  );
  return CATALOG.map((manifest) => {
    const row = recorded.get(manifest.id);
    if (row === undefined) {
      return { provider: manifest.id, state: "unchecked", detail: null, checkedAt: null };
    }
    return {
      provider: row.provider,
      state: row.state,
      detail: row.detail,
      checkedAt: row.checked_at,
    };
  });
}

export function addConnectionHealthRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/connections/health", async (context) => {
    await requirePrincipal(context);
    return context.json({
      providers: await listProviderHealth(runtimeFactory(context).db),
    });
  });
}
