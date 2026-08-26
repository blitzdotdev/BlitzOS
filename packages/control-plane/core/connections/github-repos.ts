import { fetchBoundedJson, type JsonValue } from "../compute/json-fetch.js";
import { HttpError, isRecord, isString } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import type { GithubRepositoryView, ListGithubRepositoriesResponse } from "../wire.js";
import { grantFor, openGrantSecret } from "./user-grants.js";

/** GitHub repository objects carry dozens of fields apiece, so a page of 8
 * stays comfortably under the 64 KiB bounded-response cap. That cap is why
 * pagination is mandatory here — one per_page=100 request would truncate. */
const REPOS_PER_PAGE = 8;
const MAX_REPOSITORIES = 200;

/** `/user/repos` answers with a bare array, unlike the installation listing's
 * `{ repositories: [...] }` envelope this route used to read. */
function parseRepositoryPage(value: JsonValue | null): GithubRepositoryView[] {
  if (!Array.isArray(value)) {
    throw new HttpError(502, "github returned an invalid repository listing");
  }
  const parsed: GithubRepositoryView[] = [];
  for (const entry of value) {
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

/** What this person's own token can reach, which is exactly what a workspace
 * running on that token will be able to clone. An org credential used to
 * answer here and could list repositories the member themselves could not
 * open. */
async function listMemberRepositories(token: string): Promise<GithubRepositoryView[]> {
  const repositories: GithubRepositoryView[] = [];
  const maxPages = Math.ceil(MAX_REPOSITORIES / REPOS_PER_PAGE);
  for (let page = 1; page <= maxPages; page += 1) {
    const { response, body } = await fetchBoundedJson(
      globalThis.fetch,
      // affiliation keeps the list to repositories the person can actually
      // push to or was given access to, rather than everything visible to
      // them through an organization they merely belong to.
      `https://api.github.com/user/repos?per_page=${String(REPOS_PER_PAGE)}`
        + `&page=${String(page)}&sort=updated`
        + "&affiliation=owner,collaborator,organization_member",
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
 *
 * It reads the caller's own GitHub grant. There is no org-wide GitHub
 * credential any more: a shared one attributed every commit to itself, and it
 * could offer a member repositories their own account could not open. 409
 * tells the webApp this person has not connected GitHub yet, which the picker
 * renders as its disabled hint. */
export function addGithubRepositoryRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/connections/github/repositories", async (context) => {
    const runtime = runtimeFactory(context);
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const grant = await grantFor(runtime.db, principal.id, "github");
    // A pasted token lives in the refresh slot. An `oauth` grant predates the
    // move to personal tokens: its access token expires in hours and can never
    // refresh, because the manifest has no authorize endpoint any more. Sending
    // it would earn a 401 from GitHub and surface as a 502 — the mint path
    // answers 409 for the same row, so this one does too.
    if (grant === null || grant.kind !== "pat") {
      throw new HttpError(409, "connect github");
    }
    const token = await openGrantSecret(runtime.credentialMasterKey, grant, "refresh");
    if (token === null) throw new HttpError(409, "connect github");
    return context.json<ListGithubRepositoriesResponse>({
      repositories: await listMemberRepositories(token),
    });
  });
}
