import type { Db } from "./db.js";
import { rows } from "./db.js";
import { HttpError, requiredString, type JsonValue } from "./http.js";

export const MAX_TEMPLATE_REPOS = 16;

/** "owner/name". Also the shell-safety boundary: the bootstrap interpolates
 * each repo into the emitted clone loop, so nothing beyond this alphabet may
 * ever reach the table. */
const TEMPLATE_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export interface TemplateRepoRow {
  template_id: string;
  repo: string;
}

export function parseTemplateRepos(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "repos must be an array");
  const repos = [...new Set(value.map((entry, index) =>
    requiredString(entry, `repos[${String(index)}]`, 256)))];
  if (repos.length > MAX_TEMPLATE_REPOS) {
    throw new HttpError(400, `repos must have at most ${String(MAX_TEMPLATE_REPOS)} entries`);
  }
  const byBasename = new Map<string, string>();
  for (const repo of repos) {
    if (!TEMPLATE_REPO_PATTERN.test(repo)) {
      throw new HttpError(400, `repos entries must be "owner/name": ${repo}`);
    }
    // Every repo clones into /workspace/<name>, so two repos sharing a name
    // would fight over one directory. Refuse at save time, not at boot.
    const basename = repo.slice(repo.indexOf("/") + 1);
    const twin = byBasename.get(basename);
    if (twin !== undefined) {
      throw new HttpError(400, `repos ${twin} and ${repo} clone into the same directory`);
    }
    byBasename.set(basename, repo);
  }
  return repos;
}

export async function templateRepoRows(
  db: Db,
  templateIds: string[],
): Promise<TemplateRepoRow[]> {
  if (templateIds.length === 0) return [];
  return rows<TemplateRepoRow>(db, {
    q: `SELECT template_id, repo FROM workspace_template_repos
        WHERE template_id IN (${templateIds.map((_id, index) => `?${String(index + 1)}`).join(",")})
        ORDER BY template_id, repo`,
    v: templateIds,
  });
}

export async function replaceTemplateRepos(
  db: Db,
  templateId: string,
  repos: readonly string[],
): Promise<void> {
  await rows(db, {
    q: "DELETE FROM workspace_template_repos WHERE template_id = ?1",
    v: [templateId],
  });
  for (const repo of repos) {
    await rows(db, {
      q: "INSERT INTO workspace_template_repos (template_id, repo) VALUES (?1, ?2)",
      v: [templateId, repo],
    });
  }
}

/** The repos a workspace created from this template clones, for the
 * bootstrap's clone loop. Sorted so the emitted script is deterministic. */
export async function templateRepos(db: Db, templateId: string): Promise<string[]> {
  return (await templateRepoRows(db, [templateId])).map(({ repo }) => repo);
}
