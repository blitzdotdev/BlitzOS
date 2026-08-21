import { fetchBoundedJson, type JsonValue } from "../compute/json-fetch.js";
import { HttpError, isRecord, isString } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import type { GithubRepositoryView, ListGithubRepositoriesResponse } from "../wire.js";
import { appJwt } from "./minters/app-jwt/github-app.js";
import { activeConnections } from "./registry.js";
import { openRoot } from "./root-crypto.js";

/** GitHub repository objects carry dozens of fields apiece, so a page of 8
 * stays comfortably under the 64 KiB bounded-response cap. That cap is why
 * pagination is mandatory here — one per_page=100 request would truncate. */
const REPOS_PER_PAGE = 8;
const MAX_REPOSITORIES = 200;

/** The slice of the github connection config this route needs, parsed at the
 * boundary. `repositories`/`permissions` mirror what the mint path sends, so
 * the picker lists exactly what a runtime clone token can reach. */
interface GithubListingConfig {
  app_id: string;
  installation_id: string;
  repositories?: string[];
  permissions?: Record<string, string>;
}

function parseListingConfig(value: string): GithubListingConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HttpError(409, "connect github");
  }
  if (!isRecord(parsed) || !isString(parsed.app_id) || !isString(parsed.installation_id)) {
    throw new HttpError(409, "connect github");
  }
  const config: GithubListingConfig = {
    app_id: parsed.app_id,
    installation_id: parsed.installation_id,
  };
  if (Array.isArray(parsed.repositories) && parsed.repositories.every(isString)) {
    config.repositories = parsed.repositories;
  }
  if (isRecord(parsed.permissions)) {
    const permissions: Record<string, string> = {};
    for (const [permission, level] of Object.entries(parsed.permissions)) {
      if (isString(level)) permissions[permission] = level;
    }
    config.permissions = permissions;
  }
  return config;
}

interface GithubTokenRequestBody {
  repositories?: string[];
  permissions?: Record<string, string>;
}

async function installationToken(root: string, config: GithubListingConfig): Promise<string> {
  const body: GithubTokenRequestBody = {};
  if (config.repositories !== undefined) body.repositories = config.repositories;
  if (config.permissions !== undefined) body.permissions = config.permissions;
  const { response, body: parsed } = await fetchBoundedJson(
    globalThis.fetch,
    `https://api.github.com/app/installations/${config.installation_id}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${await appJwt(root, config, Date.now())}`,
        "Content-Type": "application/json",
        "User-Agent": "blitz-control-plane",
      },
      body: JSON.stringify(body),
    },
    {
      responseLabel: "GitHub installation token",
      bodyDisposition: () => "read",
      invalidJsonDisposition: () => "provider-error",
    },
  );
  if (!response.ok) {
    throw new HttpError(
      502,
      `github installation token request failed with status ${String(response.status)}`,
    );
  }
  if (!isRecord(parsed) || !isString(parsed.token)) {
    throw new HttpError(502, "github returned an invalid installation token response");
  }
  return parsed.token;
}

function parseRepositoryPage(value: JsonValue | null): GithubRepositoryView[] {
  if (!isRecord(value) || !Array.isArray(value.repositories)) {
    throw new HttpError(502, "github returned an invalid repository listing");
  }
  const parsed: GithubRepositoryView[] = [];
  for (const entry of value.repositories) {
    if (
      !isRecord(entry) ||
      !isString(entry.full_name) ||
      (entry.private !== true && entry.private !== false)
    ) {
      throw new HttpError(502, "github returned an invalid repository listing");
    }
    parsed.push({ fullName: entry.full_name, private: entry.private });
  }
  return parsed;
}

async function listInstallationRepositories(token: string): Promise<GithubRepositoryView[]> {
  const repositories: GithubRepositoryView[] = [];
  const maxPages = Math.ceil(MAX_REPOSITORIES / REPOS_PER_PAGE);
  for (let page = 1; page <= maxPages; page += 1) {
    const { response, body } = await fetchBoundedJson(
      globalThis.fetch,
      `https://api.github.com/installation/repositories?per_page=${String(REPOS_PER_PAGE)}&page=${String(page)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "blitz-control-plane",
        },
      },
      {
        responseLabel: "GitHub repository listing",
        bodyDisposition: () => "read",
        invalidJsonDisposition: () => "provider-error",
      },
    );
    if (!response.ok) {
      throw new HttpError(
        502,
        `github repository listing failed with status ${String(response.status)}`,
      );
    }
    const pageRepositories = parseRepositoryPage(body);
    for (const repository of pageRepositories) {
      if (repositories.length >= MAX_REPOSITORIES) return repositories;
      repositories.push(repository);
    }
    if (pageRepositories.length < REPOS_PER_PAGE) break;
  }
  return repositories;
}

/** GET /connections/github/repositories — the template repo picker's source.
 * Active-member read (picking repos for a template is not an admin act); the
 * secret stays server-side: the app JWT and installation token never leave
 * this route. 409 tells the webapp the github connection is not configured
 * yet, which the picker renders as its disabled hint. */
export function addGithubRepositoryRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/connections/github/repositories", async (context) => {
    const runtime = runtimeFactory(context);
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const connection = (await activeConnections(runtime.db, principal.orgId)).find(
      (candidate) => candidate.provider === "github" && candidate.kind === "app-jwt",
    );
    const rootCiphertext = connection?.root_ciphertext ?? null;
    if (connection === undefined || rootCiphertext === null) {
      throw new HttpError(409, "connect github");
    }
    const root = await openRoot(runtime.credentialMasterKey, connection.name, rootCiphertext);
    const token = await installationToken(root, parseListingConfig(connection.config));
    return context.json<ListGithubRepositoriesResponse>({
      repositories: await listInstallationRepositories(token),
    });
  });
}
