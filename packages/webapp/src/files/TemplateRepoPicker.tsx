import type {
  GithubRepositoryView,
  ListGithubInstallationsResponse,
  ListGithubRepositoriesResponse,
} from '@blitzos/schema';
import { useEffect, useState } from 'react';
import { ApiRequestError } from '../api';
import { MAX_TEMPLATE_REPOS, repoBasenameCollision } from './repo-urls';

const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/blitzosauth/installations/new';

export interface TemplateRepoPickerApi {
  listGithubInstallations(): Promise<ListGithubInstallationsResponse>;
  listGithubRepositories(): Promise<ListGithubRepositoriesResponse>;
}

type PickerState =
  | { kind: 'loading' }
  | { kind: 'connect' }
  | { kind: 'install' }
  | { kind: 'ready'; repositories: GithubRepositoryView[]; truncated: boolean }
  | { kind: 'error'; message: string };

/** Lists only repos the member's own credential reaches. App installation
 * widens that reach, but never supplies identity. The App is the only path
 * here: a 409 means no grant or a pasted personal token, and either way the
 * answer is the same member connect action. An empty App installation list is
 * the separate owner action. */
export function TemplateRepoPicker({
  client,
  connectHref,
  onConnect,
  value,
  onChange,
}: {
  client: TemplateRepoPickerApi;
  connectHref: string;
  onConnect: () => void;
  value: string[];
  onChange: (repos: string[]) => void;
}) {
  const [state, setState] = useState<PickerState>({ kind: 'loading' });
  const [search, setSearch] = useState('');
  const [account, setAccount] = useState('');
  const [selectionProblem, setSelectionProblem] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let mounted = true;
    setState({ kind: 'loading' });
    void client.listGithubRepositories()
      .then(async (result) => {
        if (result.repositories.length === 0) {
          // The repositories route intentionally omits installation rows. Only
          // the empty result needs this second read to distinguish "no install"
          // from "installed, but no repositories in the member intersection".
          const { installations } = await client.listGithubInstallations();
          if (!mounted) return;
          if (installations.length === 0) {
            setState({ kind: 'install' });
            return;
          }
        }
        if (mounted) {
          setState({
            kind: 'ready',
            repositories: result.repositories,
            truncated: result.truncated,
          });
        }
      })
      .catch((caught: Error) => {
        if (!mounted) return;
        if (caught instanceof ApiRequestError && caught.status === 409) {
          setState({ kind: 'connect' });
          return;
        }
        setState({ kind: 'error', message: caught.message });
      });
    return () => { mounted = false; };
  }, [client, refreshVersion]);

  if (state.kind === 'loading') {
    return <p className="tplf-repos-hint" role="status">Loading GitHub repositories…</p>;
  }
  if (state.kind === 'connect') {
    return (
      <div className="tplf-repos-setup">
        <p>Connect GitHub to list repositories that your account can reach.</p>
        <a
          className="webapp-action webapp-action--primary"
          href={connectHref}
          onClick={onConnect}
        >
          Connect GitHub
        </a>
      </div>
    );
  }
  if (state.kind === 'install') {
    return (
      <div className="tplf-repos-setup">
        <p>
          A GitHub organization owner must install the BlitzOS App before org
          repositories appear here. GitHub does not return to this page after installation.
        </p>
        <div className="tplf-repos-setup-actions">
          <a
            className="webapp-action webapp-action--primary"
            href={GITHUB_APP_INSTALL_URL}
            target="_blank"
            rel="noreferrer"
          >
            Install GitHub App
          </a>
          <button
            className="tplf-repo-urls-add"
            type="button"
            onClick={() => setRefreshVersion((current) => current + 1)}
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="tplf-repos-setup">
        <p className="webapp-form-message" role="alert">{state.message}</p>
        <button
          className="tplf-repo-urls-add"
          type="button"
          onClick={() => setRefreshVersion((current) => current + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  const accounts = [...new Set(state.repositories.map(({ accountLogin }) => accountLogin))]
    .sort((left, right) => left.localeCompare(right));
  const selectedAccount = accounts.includes(account) ? account : '';
  const needle = search.trim().toLowerCase();
  const shown = state.repositories.filter((repository) => (
    (selectedAccount === '' || repository.accountLogin === selectedAccount)
    && (needle === '' || repository.repo.toLowerCase().includes(needle))
  ));
  const atCap = value.length >= MAX_TEMPLATE_REPOS;
  const toggle = (repo: string) => {
    if (value.includes(repo)) {
      setSelectionProblem(null);
      onChange(value.filter((candidate) => candidate !== repo));
      return;
    }
    const other = repoBasenameCollision(value, repo);
    if (other !== null) {
      setSelectionProblem(`${repo} clones into the same folder as ${other}`);
      return;
    }
    setSelectionProblem(null);
    onChange([...value, repo]);
  };

  return (
    <div className="tplf-repos-picker">
      <div className="tplf-repos-controls">
        <input
          aria-label="Search repositories"
          placeholder="Search repositories…"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        <select
          aria-label="Filter repositories by account"
          value={selectedAccount}
          onChange={(event) => setAccount(event.currentTarget.value)}
        >
          <option value="">All accounts</option>
          {accounts.map((login) => <option key={login} value={login}>{login}</option>)}
        </select>
      </div>
      {atCap && (
        <p className="tplf-repos-hint" role="status">
          Up to {MAX_TEMPLATE_REPOS} repositories — remove one to add another.
        </p>
      )}
      {selectionProblem !== null && (
        <p className="webapp-form-message" role="alert">{selectionProblem}</p>
      )}
      {state.truncated && (
        <p className="tplf-repos-hint" role="status">
          GitHub returned a partial repository list. Search may not include every repository.
        </p>
      )}
      <div className="tplf-repos-list" role="listbox" aria-label="GitHub repositories">
        {shown.map((repository) => {
          const selected = value.includes(repository.repo);
          return (
            <label className="tplf-repo" key={repository.repo}>
              <input
                type="checkbox"
                checked={selected}
                disabled={!selected && atCap}
                onChange={() => toggle(repository.repo)}
              />
              <span>{repository.repo}</span>
              {repository.private && <em className="tplf-chip">private</em>}
            </label>
          );
        })}
        {shown.length === 0 && (
          <p className="tplf-repos-hint">
            {state.repositories.length === 0
              ? 'The installed App reaches no repositories available to your account.'
              : 'No repositories match these filters.'}
          </p>
        )}
      </div>
      <div className="tplf-repos-listfoot">
        <span className="tplf-repos-count">
          {value.length === 0
            ? 'No repositories selected'
            : `${String(value.length)} ${value.length === 1 ? 'repository' : 'repositories'} selected`}
        </span>
        {/* Refresh repeats here, not only in the empty state. GitHub never
         * returns to this page after an install, so the list cannot re-read
         * itself. Without this, an account installed mid-session stays
         * invisible until the whole screen is rebuilt. */}
        <button
          className="tplf-repos-refresh"
          type="button"
          onClick={() => setRefreshVersion((current) => current + 1)}
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
