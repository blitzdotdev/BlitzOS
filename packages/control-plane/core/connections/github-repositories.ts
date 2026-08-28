import { fetchBoundedText } from "../compute/json-fetch.js";
import { HttpError, isBoolean, isNumber, isRecord, isString, type JsonValue } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, CoreRuntime, RuntimeFactory } from "../runtime.js";
import { TEMPLATE_REPO_PATTERN } from "../template-repos.js";
import type {
  GithubInstallationView,
  GithubRepositoryView,
  ListGithubInstallationsResponse,
  ListGithubRepositoriesResponse,
} from "../wire.js";
import { githubManifest } from "./catalog/github.js";
import { refreshedAccessToken } from "./minters/oauth.js";
import { grantFor, openGrantSecret } from "./user-grants.js";

const GITHUB_API = "https://api.github.com";
// GitHub repository objects carry dozens of fields. One hundred entries can
// exceed json-fetch's 64 KiB response cap before the boundary parser runs.
// Eight matches the earlier picker route and stays below that fixed cap.
const GITHUB_ITEMS_PER_PAGE = 8;
// One refresh plus forty-eight GitHub pages fits the smallest Worker allowance
// of fifty subrequests. Installation pages share this budget with repository
// pages; resetting it per account would make a large member fail only after the
// Worker killed the request.
const MAX_GITHUB_PAGES = 48;

export interface GithubCallerCredential {
  token: string;
  kind: "oauth" | "pat";
}

/** Resolves the member's one live GitHub grant through the same refresh path
 * minting uses. Personal tokens live in the refresh slot because they do not
 * expire; OAuth grants prefer their access token and rotate it when needed. */
export async function githubCallerCredential(
  runtime: CoreRuntime,
  userId: string,
): Promise<GithubCallerCredential | null> {
  const grant = await grantFor(runtime.db, userId, githubManifest.id);
  if (grant === null) return null;
  if (grant.kind === "pat") {
    const token = await openGrantSecret(runtime.credentialMasterKey, grant, "refresh");
    if (token === null) throw new HttpError(409, "GitHub connection grant has no stored key");
    return { token, kind: "pat" };
  }
  const { auth } = githubManifest;
  const clientId = runtime.vars.connectSecret(auth.clientIdVar);
  const clientSecret = runtime.vars.connectSecret(auth.clientSecretVar);
  if (clientId === undefined || clientSecret === undefined) {
    throw new HttpError(409, "GitHub is not configured on this instance");
  }
  const access = await refreshedAccessToken(
    {
      db: runtime.db,
      key: runtime.credentialMasterKey,
      clientId,
      clientSecret,
      // Refresh exchanges never send a redirect URI.
      redirectUri: null,
    },
    githubManifest,
    grant,
  );
  if (access === null) throw new HttpError(409, "GitHub connection needs re-authorization");
  return { token: access.accessToken, kind: "oauth" };
}

interface GithubApiPage {
  body: JsonValue;
  next: string | null;
}

async function githubApiPage(
  token: string,
  url: string,
  label: string,
): Promise<GithubApiPage> {
  let fetched;
  try {
    fetched = await fetchBoundedText(
      globalThis.fetch,
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "blitz-control-plane",
        },
      },
      { responseLabel: label, bodyDisposition: () => "read" },
    );
  } catch {
    throw new HttpError(502, `${label} request failed`);
  }
  if (fetched.response.status < 200 || fetched.response.status >= 300) {
    throw new HttpError(502, `${label} request failed`);
  }
  if (fetched.body === null) throw new HttpError(502, `${label} returned an empty response`);
  let body: JsonValue;
  try {
    body = JSON.parse(fetched.body);
  } catch {
    throw new HttpError(502, `${label} returned invalid JSON`);
  }
  return { body, next: nextGithubPage(fetched.response.headers.get("Link")) };
}

function nextGithubPage(link: string | null): string | null {
  if (link === null) return null;
  for (const entry of link.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="next"(?:;|\s*$)/u.exec(entry);
    if (match === null) continue;
    // SAFETY: the expression contains one mandatory capture for the URL.
    const href = match[1] as string;
    if (!URL.canParse(href)) {
      throw new HttpError(502, "GitHub pagination returned an invalid next URL");
    }
    const next = new URL(href);
    // A Link header is provider-controlled input. Following another origin
    // would hand the member's credential to that origin before any parser saw
    // the response.
    if (next.origin !== GITHUB_API) {
      throw new HttpError(502, "GitHub pagination returned an invalid next URL");
    }
    return next.toString();
  }
  return null;
}

function parseInstallations(value: JsonValue): GithubInstallationView[] {
  if (!isRecord(value) || !Array.isArray(value.installations)) {
    throw new HttpError(502, "GitHub installations returned an invalid response");
  }
  return value.installations.map((entry) => {
    if (
      !isRecord(entry)
      || !isNumber(entry.id)
      || !Number.isSafeInteger(entry.id)
      || entry.id <= 0
      || !isRecord(entry.account)
      || !isString(entry.account.login)
      || entry.account.login.length === 0
      || !isString(entry.account.type)
      || entry.account.type.length === 0
      || (entry.repository_selection !== "all" && entry.repository_selection !== "selected")
    ) {
      throw new HttpError(502, "GitHub installations returned an invalid response");
    }
    return {
      id: entry.id,
      accountLogin: entry.account.login,
      accountType: entry.account.type,
      repositorySelection: entry.repository_selection,
    };
  });
}

function parseRepositories(value: JsonValue): GithubRepositoryView[] {
  // Only the installation endpoint answers now, and it wraps its rows.
  const entries = isRecord(value) ? value.repositories : undefined;
  if (!Array.isArray(entries)) {
    throw new HttpError(502, "GitHub repositories returned an invalid response");
  }
  return entries.map((entry) => {
    const fullName = isRecord(entry) ? entry.full_name : undefined;
    const isPrivate = isRecord(entry) ? entry.private : undefined;
    if (
      !isRecord(entry)
      || !isString(fullName)
      || !TEMPLATE_REPO_PATTERN.test(fullName)
      || !isBoolean(isPrivate)
    ) {
      throw new HttpError(502, "GitHub repositories returned an invalid response");
    }
    return {
      repo: fullName,
      accountLogin: fullName.replace(/\/.*$/u, ""),
      private: isPrivate,
    };
  });
}

async function githubInstallations(
  token: string,
  maxPages: number,
): Promise<{ installations: GithubInstallationView[]; pages: number; truncated: boolean }> {
  const byId = new Map<number, GithubInstallationView>();
  let next: string | null =
    `${GITHUB_API}/user/installations?per_page=${String(GITHUB_ITEMS_PER_PAGE)}`;
  let pages = 0;
  while (next !== null && pages < maxPages) {
    const page = await githubApiPage(token, next, "GitHub installations");
    pages += 1;
    for (const installation of parseInstallations(page.body)) {
      byId.set(installation.id, installation);
    }
    next = page.next;
  }
  return { installations: [...byId.values()], pages, truncated: next !== null };
}

async function installationRepositories(
  token: string,
  installations: readonly GithubInstallationView[],
  maxPages: number,
): Promise<{ repositories: GithubRepositoryView[]; truncated: boolean }> {
  const byRepo = new Map<string, GithubRepositoryView>();
  let pages = 0;
  let truncated = false;
  for (const [index, installation] of installations.entries()) {
    let next: string | null =
      `${GITHUB_API}/user/installations/${String(installation.id)}/repositories`
      + `?per_page=${String(GITHUB_ITEMS_PER_PAGE)}`;
    while (next !== null && pages < maxPages) {
      const page = await githubApiPage(token, next, "GitHub repositories");
      pages += 1;
      for (const repository of parseRepositories(page.body)) {
        byRepo.set(repository.repo, repository);
      }
      next = page.next;
    }
    if (next !== null || (pages === maxPages && index < installations.length - 1)) {
      truncated = true;
      break;
    }
  }
  return { repositories: [...byRepo.values()], truncated };
}

/** Both listing routes are App-only, so a pasted token is refused with the
 * same 409 a missing grant returns and the picker offers Connect for either.
 * A personal token carries whatever reach its holder chose on github.com,
 * which the product can neither see nor trust: falling back to it would make
 * one screen list different repositories for two members of the same org, for
 * reasons neither of them could see. */
async function requiredAppToken(
  runtime: CoreRuntime,
  principal: Principal,
): Promise<string> {
  const credential = await githubCallerCredential(runtime, principal.id);
  if (credential === null) throw new HttpError(409, "GitHub is not connected");
  if (credential.kind !== "oauth") {
    throw new HttpError(409, "connect GitHub through the App to list repositories");
  }
  return credential.token;
}

/** Lists only repositories the caller's own token can reach. An App install
 * widens that member-token intersection; it never creates a shared
 * credential or an installation-token mint path. */
export function addGithubRepositoryRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/connections/github/installations", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const token = await requiredAppToken(runtimeFactory(context), principal);
    const result = await githubInstallations(token, MAX_GITHUB_PAGES);
    if (result.truncated) {
      throw new HttpError(502, "GitHub installations exceeded the page limit");
    }
    return context.json<ListGithubInstallationsResponse>({
      installations: result.installations,
    });
  });

  router.get("/connections/github/repositories", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const token = await requiredAppToken(runtimeFactory(context), principal);
    const installed = await githubInstallations(token, MAX_GITHUB_PAGES);
    const result = installed.truncated
      ? { repositories: [], truncated: true }
      : await installationRepositories(
          token,
          installed.installations,
          MAX_GITHUB_PAGES - installed.pages,
        );
    return context.json<ListGithubRepositoriesResponse>(result);
  });
}
