import type { CheckGithubRepositoriesResponse } from '@blitzos/schema';
import { useId, useState } from 'react';
import { MAX_TEMPLATE_REPOS } from './TemplateRepoPicker';
import { parseRepoUrlLines, type RepoUrlLine } from './repo-urls';

export interface TemplateRepoCheckApi {
  checkGithubRepositories(repos: string[]): Promise<CheckGithubRepositoriesResponse>;
}

interface RepoProblem {
  raw: string | null;
  problem: string;
}

function lineProblem(line: RepoUrlLine, problem: string): RepoProblem {
  return { raw: line.raw, problem };
}

export function TemplateRepoUrls({
  client,
  value,
  onChange,
  installationRepos,
}: {
  client: TemplateRepoCheckApi;
  /** Every repo on the template, picker-chosen and typed alike. */
  value: string[];
  onChange: (repos: string[]) => void;
  /** Repos the org's GitHub App installation reaches. null while the picker is still
   * loading, so rows do not flash in and out. */
  installationRepos: ReadonlySet<string> | null;
}) {
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<RepoProblem[]>([]);
  const [checking, setChecking] = useState(false);
  const inputId = useId();
  const typedRepos = installationRepos === null
    ? []
    : value.filter((repo) => !installationRepos.has(repo));

  const add = async () => {
    const lines = parseRepoUrlLines(text);
    if (lines.length === 0) {
      setProblems([{ raw: null, problem: 'add at least one URL' }]);
      return;
    }

    const parseProblems = lines
      .filter((line) => line.problem !== null)
      .map((line) => lineProblem(line, line.problem ?? 'not a repository URL'));
    if (parseProblems.length > 0) {
      setProblems(parseProblems);
      return;
    }

    const additions: string[] = [];
    for (const line of lines) {
      if (line.repo !== null) additions.push(line.repo);
    }

    const existing = new Set(value);
    const seen = new Set<string>();
    const duplicateProblems: RepoProblem[] = [];
    for (const [index, repo] of additions.entries()) {
      const line = lines[index];
      if (line === undefined) continue;
      if (existing.has(repo)) duplicateProblems.push(lineProblem(line, 'already added'));
      else if (seen.has(repo)) duplicateProblems.push(lineProblem(line, 'listed twice'));
      seen.add(repo);
    }
    if (duplicateProblems.length > 0) {
      setProblems(duplicateProblems);
      return;
    }

    // Match packages/control-plane/core/template-repos.ts so save never
    // rejects repositories the editor already accepted.
    const reposByBasename = new Map(value.map((repo) => [repo.slice(repo.indexOf('/') + 1), repo]));
    const collisionProblems: RepoProblem[] = [];
    for (const [index, repo] of additions.entries()) {
      const basename = repo.slice(repo.indexOf('/') + 1);
      const other = reposByBasename.get(basename);
      const line = lines[index];
      if (other !== undefined && line !== undefined) {
        collisionProblems.push(lineProblem(line, `clones into the same folder as ${other}`));
      } else {
        reposByBasename.set(basename, repo);
      }
    }
    if (collisionProblems.length > 0) {
      setProblems(collisionProblems);
      return;
    }

    if (value.length + additions.length > MAX_TEMPLATE_REPOS) {
      setProblems([{
        raw: null,
        problem: `at most ${String(MAX_TEMPLATE_REPOS)} repositories per template`,
      }]);
      return;
    }

    setChecking(true);
    try {
      const { results } = await client.checkGithubRepositories(additions);
      const reachabilityProblems = results.flatMap((result): RepoProblem[] => {
        if (result.reachable) return [];
        return [{
          raw: result.repo,
          problem: result.failure === 'not-public'
            ? 'not found, or it is private'
            : 'GitHub could not be reached',
        }];
      });
      if (reachabilityProblems.length > 0) {
        setProblems(reachabilityProblems);
        return;
      }
      onChange([...value, ...additions]);
      setText('');
      setProblems([]);
    } catch (caught) {
      setProblems([{
        raw: null,
        problem: caught instanceof Error ? caught.message : 'the check could not be run',
      }]);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="tplf-repo-urls">
      {typedRepos.length > 0 && (
        <div className="tplf-repo-url-rows">
          {typedRepos.map((repo) => (
            <div className="tplf-repo-url-row" key={repo}>
              <span>{repo}</span>
              <button
                type="button"
                aria-label={`Remove ${repo}`}
                onClick={() => onChange(value.filter((candidate) => candidate !== repo))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <label className="tplf-repo-urls-label" htmlFor={inputId}>
        Public repositories
      </label>
      <p>One URL per line. Any public repo, no GitHub setup needed.</p>
      {problems.length > 0 && (
        <ul className="tplf-repo-urls-problems" role="alert">
          {problems.map((problem, index) => (
            <li key={`${problem.raw ?? 'batch'}-${String(index)}`}>
              {problem.raw === null
                ? problem.problem
                : `${problem.raw} — ${problem.problem}`}
            </li>
          ))}
        </ul>
      )}
      <textarea
        id={inputId}
        aria-label="Public repository URLs"
        placeholder="https://github.com/owner/name"
        className={`tplf-repo-urls-input${problems.length > 0 ? ' tplf-invalid' : ''}`}
        value={text}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setProblems([]);
        }}
      />
      <button
        className="tplf-repo-urls-add"
        type="button"
        disabled={text.trim() === '' || checking}
        onClick={() => { void add(); }}
      >
        {checking ? 'Checking…' : 'Add'}
      </button>
    </div>
  );
}
