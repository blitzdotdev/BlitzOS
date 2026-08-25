import { fetchBoundedText } from "../compute/json-fetch.js";
import { HttpError, isRecord, readJson, requiredString, type JsonValue } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter } from "../runtime.js";
import { MAX_TEMPLATE_REPOS, TEMPLATE_REPO_PATTERN } from "../template-repos.js";
import type {
  CheckGithubRepositoriesRequest,
  CheckGithubRepositoriesResponse,
  GithubRepositoryCheckView,
} from "../wire.js";

function parseCheckGithubRepositoriesRequest(
  value: JsonValue,
): CheckGithubRepositoriesRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  if (!Array.isArray(value.repos)) throw new HttpError(400, "repos must be an array");
  const repos = [...new Set(value.repos.map((entry, index) =>
    requiredString(entry, `repos[${String(index)}]`, 256)))];
  if (repos.length > MAX_TEMPLATE_REPOS) {
    throw new HttpError(400, `repos must have at most ${String(MAX_TEMPLATE_REPOS)} entries`);
  }
  if (repos.length === 0) throw new HttpError(400, "repos must not be empty");
  for (const repo of repos) {
    if (!TEMPLATE_REPO_PATTERN.test(repo)) {
      throw new HttpError(400, `repos entries must be "owner/name": ${repo}`);
    }
  }
  // Basename collisions concern the complete saved template. Save time owns
  // that check because a probe may cover only the repos a person just added.
  return { repos };
}

/** Probe Git transport instead of the REST repository endpoint. This is the
 * exact first request `git clone` makes, so 200 proves the bootstrap clone can
 * succeed without credentials. The REST API allows only 60 anonymous requests
 * per hour per source IP, which shared Worker egress can exhaust; this
 * endpoint does not carry that limit. GitHub deliberately answers 401 for
 * both private and missing repos, so "not-public" is the honest verdict. */
async function checkGithubRepository(repo: string): Promise<GithubRepositoryCheckView> {
  try {
    const { response } = await fetchBoundedText(
      globalThis.fetch,
      `https://github.com/${repo}.git/info/refs?service=git-upload-pack`,
      {
        method: "GET",
        // The verdict must match the bootstrap's anonymous clone.
        headers: { "User-Agent": "blitz-control-plane" },
      },
      {
        responseLabel: "GitHub repository probe",
        bodyDisposition: () => "omit",
      },
    );
    if (response.status === 200) return { repo, reachable: true };
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { repo, reachable: false, failure: "not-public" };
    }
    return { repo, reachable: false, failure: "unreachable" };
  } catch {
    return { repo, reachable: false, failure: "unreachable" };
  }
}

/** POST /connections/github/repositories/check — proves public repos can be
 * cloned by the credential-free bootstrap path. Picking repos for a template
 * is an active-member read, not an admin act. No runtime factory: the probe
 * reads no stored credential and touches no row, so it needs no database. */
export function addGithubRepositoryCheckRoutes(
  router: CoreRouter,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.post("/connections/github/repositories/check", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const request = parseCheckGithubRepositoriesRequest(await readJson(context.req.raw));
    return context.json<CheckGithubRepositoriesResponse>({
      // Sixteen concurrent probes stay well inside the Worker subrequest budget.
      results: await Promise.all(request.repos.map(checkGithubRepository)),
    });
  });
}
