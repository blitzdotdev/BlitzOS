import { fetchBoundedText } from "../compute/json-fetch.js";
import { HttpError, isRecord, readJson, requiredString, type JsonValue } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import {
  MAX_TEMPLATE_REPOS,
  TEMPLATE_REPO_PATTERN,
  type TemplateRepo,
} from "../template-repos.js";
import type {
  CheckGithubRepositoriesRequest,
  CheckGithubRepositoriesResponse,
  GithubRepositoryCheckView,
} from "../wire.js";
import { githubCallerCredential } from "./github-repositories.js";

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
 * exact first request `git clone` makes. The REST API allows only 60 anonymous
 * requests per hour per source IP, which shared Worker egress can exhaust;
 * this endpoint does not carry that limit. */
async function gitProbeStatus(repo: string, token: string | null): Promise<number | null> {
  try {
    const headers = new Headers({ "User-Agent": "blitz-control-plane" });
    if (token !== null) {
      // Measured against GitHub's git endpoint: Bearer answers 401 while
      // Basic with this fixed username accepts the same user token.
      headers.set("Authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
    }
    const { response } = await fetchBoundedText(
      globalThis.fetch,
      `https://github.com/${repo}.git/info/refs?service=git-upload-pack`,
      {
        method: "GET",
        headers,
      },
      {
        responseLabel: "GitHub repository probe",
        bodyDisposition: () => "omit",
      },
    );
    return response.status;
  } catch {
    return null;
  }
}

function hidden(status: number | null): boolean {
  return status === 401 || status === 403 || status === 404;
}

async function checkGithubRepository(
  repo: string,
  token: string | null,
): Promise<GithubRepositoryCheckView> {
  if (token === null) {
    // The credential-free answer still matches a public bootstrap clone. A
    // private repo is deliberately indistinguishable from a missing one, so
    // GitHub's hidden response becomes the only closed verdict available.
    const status = await gitProbeStatus(repo, null);
    if (status === 200) return { repo, verdict: "public" };
    if (hidden(status)) return { repo, verdict: "not-found" };
    return { repo, verdict: "unreachable" };
  }

  const authenticated = await gitProbeStatus(repo, token);
  const anonymous = await gitProbeStatus(repo, null);
  if (anonymous === 200) return { repo, verdict: "public" };
  if (authenticated === 200 && hidden(anonymous)) {
    return { repo, verdict: "private-reachable" };
  }
  if (hidden(authenticated) && hidden(anonymous)) return { repo, verdict: "not-found" };
  return { repo, verdict: "unreachable" };
}

export async function checkGithubRepositories(
  repos: readonly string[],
  token: string | null,
): Promise<GithubRepositoryCheckView[]> {
  return Promise.all(repos.map((repo) => checkGithubRepository(repo, token)));
}

/** Privacy is provider truth, not a client assertion. A template save and a
 * workspace create both receive bare names, so both run this probe before they
 * write a row: otherwise a direct API caller could label a private repository
 * public and walk past the create-time gate that keeps a doomed clone from
 * failing silently ten minutes into bootstrap. */
export async function probedRepos(
  repos: readonly string[],
  token: string | null,
): Promise<TemplateRepo[]> {
  if (repos.length === 0) return [];
  const results = await checkGithubRepositories(repos, token);
  return results.map((result) => {
    if (result.verdict === "public") return { repo: result.repo, private: false };
    if (result.verdict === "private-reachable") return { repo: result.repo, private: true };
    if (result.verdict === "not-found") {
      throw new HttpError(400, `repository ${result.repo} was not found or is not reachable`);
    }
    throw new HttpError(502, `GitHub could not check repository ${result.repo}`);
  });
}

/** POST /connections/github/repositories/check — proves the clone path the
 * caller will use. Picking repos for a template is an active-member read, not
 * an admin act. */
export function addGithubRepositoryCheckRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.post("/connections/github/repositories/check", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const request = parseCheckGithubRepositoriesRequest(await readJson(context.req.raw));
    const credential = await githubCallerCredential(runtimeFactory(context), principal.id);
    return context.json<CheckGithubRepositoriesResponse>({
      // Sixteen authenticated repos need at most thirty-two probes, plus one
      // refresh. That remains below the smallest Worker subrequest allowance.
      results: await checkGithubRepositories(request.repos, credential?.token ?? null),
    });
  });
}
