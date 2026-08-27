import type { Db } from "./db.js";
import { rows } from "./db.js";
import { HttpError, requiredString, type JsonValue } from "./http.js";

export const MAX_TEMPLATE_REPOS = 16;

/** "owner/name". Also the shell-safety boundary: the bootstrap interpolates
 * each repo into the emitted clone loop, so nothing beyond this alphabet may
 * ever reach the table. */
export const TEMPLATE_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export interface TemplateRepoRow {
  template_id: string;
  repo: string;
  private: number;
}

export interface TemplateRepo {
  repo: string;
  private: boolean;
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
    q: `SELECT template_id, repo, private FROM workspace_template_repos
        WHERE template_id IN (${templateIds.map((_id, index) => `?${String(index + 1)}`).join(",")})
        ORDER BY template_id, repo`,
    v: templateIds,
  });
}

export async function replaceTemplateRepos(
  db: Db,
  templateId: string,
  repos: readonly TemplateRepo[],
): Promise<void> {
  await rows(db, {
    q: "DELETE FROM workspace_template_repos WHERE template_id = ?1",
    v: [templateId],
  });
  for (const repo of repos) {
    await rows(db, {
      q: `INSERT INTO workspace_template_repos (template_id, repo, private)
          VALUES (?1, ?2, ?3)`,
      v: [templateId, repo.repo, repo.private ? 1 : 0],
    });
  }
}

/** The repos a workspace created from this template clones. Privacy gates
 * create; row order keeps the emitted bootstrap script deterministic. */
export async function templateRepos(db: Db, templateId: string): Promise<TemplateRepo[]> {
  return (await templateRepoRows(db, [templateId])).map((row) => ({
    repo: row.repo,
    private: row.private === 1,
  }));
}

/** The list a workspace owns, whichever source chose it. Written once at
 * create beside the bootstrap that clones it, so the database can answer what
 * a box holds instead of only the script that built it. */
export async function insertWorkspaceRepos(
  db: Db,
  workspaceId: string,
  repos: readonly TemplateRepo[],
): Promise<void> {
  for (const repo of repos) {
    await rows(db, {
      q: `INSERT INTO workspace_repos (workspace_id, repo, private)
          VALUES (?1, ?2, ?3)`,
      v: [workspaceId, repo.repo, repo.private ? 1 : 0],
    });
  }
}
