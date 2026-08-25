import { useEffect, useState } from 'react';
import type { GithubRepositoryView, ListGithubRepositoriesResponse } from '@blitzos/schema';
import { ApiRequestError } from '../api';

export const MAX_TEMPLATE_REPOS = 16;

export interface TemplateRepoApi {
  listGithubRepositories(): Promise<ListGithubRepositoriesResponse>;
}

/** Multi-select over the org's GitHub App installation for the template
 * screen. Disabled with a pointer at the Connections section on this same
 * page until the org GitHub App credential exists (the listing route answers
 * 409 until then); saving the credential inline flips githubConfigured, which
 * refetches, so the picker lights up without a reload. */
export function TemplateRepoPicker({
  client,
  admin,
  githubConfigured,
  value,
  onChange,
}: {
  client: TemplateRepoApi;
  /** Picks the hint's audience: admins configure inline, members ask one. */
  admin: boolean;
  /** True once an active org GitHub credential exists; a false→true flip
   * (the inline admin-form save) retries the listing. */
  githubConfigured: boolean;
  value: string[];
  onChange: (repos: string[]) => void;
}) {
  const [repositories, setRepositories] = useState<GithubRepositoryView[] | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let mounted = true;
    client.listGithubRepositories()
      .then(({ repositories: loaded }) => {
        if (!mounted) return;
        setRepositories(loaded);
        setUnconfigured(false);
        setError(null);
      })
      .catch((caught: Error) => {
        if (!mounted) return;
        if (caught instanceof ApiRequestError && caught.status === 409) setUnconfigured(true);
        else setError(caught.message);
      });
    return () => { mounted = false; };
  }, [client, githubConfigured]);

  const toggle = (fullName: string) => {
    onChange(value.includes(fullName)
      ? value.filter((repo) => repo !== fullName)
      : [...value, fullName]);
  };

  if (unconfigured) {
    return (
      <p className="tplf-repos-hint">
        {admin
          ? 'Set up GitHub above first. Repos show up here when it saves.'
          : 'Ask an admin to set up GitHub above. Repos show up here after that.'}
      </p>
    );
  }
  if (error !== null) {
    return <p className="webapp-form-message" role="alert">{error}</p>;
  }
  if (repositories === null) {
    return <p className="tplf-repos-hint" role="status">Loading repositories…</p>;
  }

  const needle = filter.trim().toLowerCase();
  const shown = needle === ''
    ? repositories
    : repositories.filter(({ fullName }) => fullName.toLowerCase().includes(needle));
  const atCap = value.length >= MAX_TEMPLATE_REPOS;

  return (
    <div className="tplf-repos-picker">
      <input
        aria-label="Filter repositories"
        placeholder="Filter repositories…"
        value={filter}
        onChange={(event) => setFilter(event.currentTarget.value)}
      />
      {atCap && (
        <p className="tplf-repos-hint" role="status">
          Up to {MAX_TEMPLATE_REPOS} repositories per template — remove one to add another.
        </p>
      )}
      <div className="tplf-repos-list" role="listbox" aria-label="GitHub repositories">
        {shown.map((repository) => {
          const selected = value.includes(repository.fullName);
          return (
            <label className="tplf-repo" key={repository.fullName}>
              <input
                type="checkbox"
                checked={selected}
                disabled={!selected && atCap}
                onChange={() => toggle(repository.fullName)}
              />
              <span>{repository.fullName}</span>
              {repository.private && <em className="tplf-chip">private</em>}
            </label>
          );
        })}
        {shown.length === 0 && (
          <p className="tplf-repos-hint">
            {repositories.length === 0
              ? 'The GitHub App installation reaches no repositories yet.'
              : 'No repositories match that filter.'}
          </p>
        )}
      </div>
      <span className="tplf-repos-count">
        {value.length === 0
          ? 'No repositories selected'
          : `${value.length} ${value.length === 1 ? 'repository' : 'repositories'} selected`}
      </span>
    </div>
  );
}
