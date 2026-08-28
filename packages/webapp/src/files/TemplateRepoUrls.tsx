import type { CheckGithubRepositoriesResponse } from '@blitzos/schema';
import { useId, useState } from 'react';
import {
  MAX_TEMPLATE_REPOS,
  parseRepoUrlLines,
  repoBasenameCollision,
  type RepoUrlLine,
} from './repo-urls';

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
}: {
  client: TemplateRepoCheckApi;
  /** Every repo on the template, picker-chosen and typed alike. */
  value: string[];
  onChange: (repos: string[]) => void;
}) {
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<RepoProblem[]>([]);
  const [checking, setChecking] = useState(false);
  const inputId = useId();

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
    const accepted = [...value];
    const collisionProblems: RepoProblem[] = [];
    for (const [index, repo] of additions.entries()) {
      const other = repoBasenameCollision(accepted, repo);
      const line = lines[index];
      if (other !== null && line !== undefined) {
        collisionProblems.push(lineProblem(line, `clones into the same folder as ${other}`));
      } else {
        accepted.push(repo);
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
        if (result.verdict === 'public' || result.verdict === 'private-reachable') return [];
        return [{
          raw: result.repo,
          problem: result.verdict === 'not-found'
            ? 'not found, or your GitHub connection cannot reach it'
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
      {/* Both inputs share this value, so picker unchecks remove rows without another sync path. */}
      {value.length > 0 && (
        <div className="tplf-attached">
          <h3 className="tplf-attached-label">Attached</h3>
          <div className="tplf-attached-list">
            {value.map((repo) => (
              <div className="tplf-attached-row" key={repo}>
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
        </div>
      )}
      <label className="tplf-repo-urls-label" htmlFor={inputId}>
        Repository URLs
      </label>
      <p>
        One GitHub URL per line. Public repos need no setup; a personal token
        can reach private repos without an App install.
      </p>
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
        aria-label="Repository URLs"
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
