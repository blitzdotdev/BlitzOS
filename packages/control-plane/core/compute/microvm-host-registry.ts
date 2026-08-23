import { first, transaction, type Db } from "../db.js";
import { safeEqualSecret } from "../crypto.js";
import { HttpError, isString } from "../http.js";
import { normalizeMicrovmHostUrl } from "./microvm-hosts.js";
import {
  type ActiveMicrovmHost,
  type ResolvedMicrovmHost,
  isDynamicMicrovmHost,
} from "./microvm-config.js";

interface MicrovmHostRow {
  url: string | null;
  source: "static" | "registered" | null;
}

function normalizedRegisteredHostUrl(raw: unknown): string {
  if (!isString(raw)) {
    throw new HttpError(400, "url must be an HTTPS URL");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "url must be an HTTPS URL");
  }
  if (
    url.protocol !== "https:"
    || url.hostname.length === 0
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new HttpError(
      400,
      "url must be an HTTPS URL without credentials, query, or fragment",
    );
  }
  return url.href.replace(/\/+$/u, "");
}

export async function syncStaticMicrovmHosts(
  db: Db,
  hosts: ResolvedMicrovmHost[],
): Promise<void> {
  const now = Date.now();
  const upserts = hosts.flatMap((host) =>
    isDynamicMicrovmHost(host)
      ? []
      : [{
          q: `INSERT INTO microvm_hosts (name, url, updated_at, source)
              VALUES (?1, ?2, ?3, 'static')
              ON CONFLICT(name) DO UPDATE SET
                url = excluded.url,
                updated_at = excluded.updated_at,
                source = excluded.source
              WHERE microvm_hosts.url IS NOT excluded.url
                 OR microvm_hosts.source IS NOT excluded.source`,
          v: [host.name, host.url, now],
        }],
  );
  if (upserts.length > 0) await transaction(db, upserts);
}

export async function prepareMicrovmHostRegistration(
  hostsByName: ReadonlyMap<string, ResolvedMicrovmHost>,
  db: Db,
  name: string,
  providedToken: string | null,
): Promise<(rawUrl: unknown) => Promise<void>> {
  const host = hostsByName.get(name);
  if (host === undefined) throw new HttpError(404, "microVM host not found");
  if (
    providedToken === null
    || !(await safeEqualSecret(providedToken, host.token))
  ) {
    throw new HttpError(401, "unauthorized");
  }
  if (!isDynamicMicrovmHost(host)) {
    throw new HttpError(409, "pinned microVM hosts cannot register");
  }
  return async (rawUrl: unknown) => {
    const url = normalizedRegisteredHostUrl(rawUrl);
    const [previousRows] = await transaction<MicrovmHostRow>(db, [
      {
        q: "SELECT url, source FROM microvm_hosts WHERE name = ?1 LIMIT 1",
        v: [host.name],
      },
      {
        q: `INSERT INTO microvm_hosts (name, url, updated_at, source)
            VALUES (?1, ?2, ?3, 'registered')
            ON CONFLICT(name) DO UPDATE SET
              url = excluded.url,
              updated_at = excluded.updated_at,
              source = excluded.source
            WHERE microvm_hosts.url IS NOT excluded.url
               OR microvm_hosts.source IS NOT excluded.source`,
        v: [host.name, url, Date.now()],
      },
    ]);
    const previousUrl = previousRows?.[0]?.url ?? null;
    if (previousUrl !== url) {
      // TODO(house-canon): Route structured core logs through the canonical logger.
      console.log(
        JSON.stringify({
          message: "microVM host URL changed",
          host: host.name,
          old_url: previousUrl,
          new_url: url,
        }),
      );
    }
  };
}

function unavailableMicrovmHost(host: ResolvedMicrovmHost): HttpError {
  return new HttpError(
    503,
    isDynamicMicrovmHost(host)
      ? `dynamic microVM host ${host.name} is unavailable; waiting for registration`
      : `pinned microVM host ${host.name} is unavailable`,
  );
}

export async function resolveMicrovmHost(
  db: Db,
  host: ResolvedMicrovmHost,
): Promise<ActiveMicrovmHost> {
  const expectedSource = isDynamicMicrovmHost(host) ? "registered" : "static";
  const row = await first<MicrovmHostRow>(db, {
    q: `SELECT url, source FROM microvm_hosts
        WHERE name = ?1 AND source = ?2
        LIMIT 1`,
    v: [host.name, expectedSource],
  });
  if (row?.url === null || row?.url === undefined) {
    throw unavailableMicrovmHost(host);
  }
  try {
    const url = isDynamicMicrovmHost(host)
      ? normalizedRegisteredHostUrl(row.url)
      : normalizeMicrovmHostUrl(row.url);
    return { name: host.name, url, token: host.token };
  } catch {
    throw unavailableMicrovmHost(host);
  }
}
