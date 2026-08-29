// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getDefaultStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchIssuesAndPRs = vi.fn();

vi.mock('@lody/shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  githubFetchIssuesAndPRs: (...args: unknown[]) => fetchIssuesAndPRs(...args),
}));

vi.mock('../src/lib/github-token', () => ({
  withGitHubTokenRetry: async (
    _workspaceId: string,
    _repoFullName: string,
    run: (token: string) => Promise<unknown>
  ) => run('token'),
}));

import { currentWorkspaceIdAtom } from '../src/atoms';
import {
  useRepoIssuesAndPRs,
  __resetIssuePrFetchFreshnessForTests,
} from '../src/components/mentions/issue-pr-hash-mention';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const REPO = 'owner/repo';

describe('issue/PR mention refresh freshness', () => {
  let root: Root;
  let container: HTMLDivElement;
  let refresh: ((options?: { force?: boolean }) => Promise<void>) | null = null;
  let itemCount = 0;

  function Probe() {
    const data = useRepoIssuesAndPRs(REPO, true);
    refresh = data.refresh;
    itemCount = data.entry?.items.length ?? 0;
    return null;
  }

  beforeEach(async () => {
    // A jsdom file shares one module instance, so the module cache carries over
    // between cases; start every test from a genuinely cold one.
    __resetIssuePrFetchFreshnessForTests();
    fetchIssuesAndPRs.mockReset();
    fetchIssuesAndPRs.mockResolvedValue([
      { number: 1, url: 'https://example.test/1', title: 'One', type: 'issue', updatedAtMs: 1 },
    ]);
    vi.useFakeTimers();
    getDefaultStore().set(currentWorkspaceIdAtom, 'ws-1');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Probe />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    getDefaultStore().set(currentWorkspaceIdAtom, null);
    refresh = null;
  });

  async function activate(options?: { force?: boolean }) {
    await act(async () => {
      await refresh?.(options);
    });
  }

  it('fetches once and serves later activations from the cache', async () => {
    await activate();
    expect(fetchIssuesAndPRs).toHaveBeenCalledTimes(1);
    expect(itemCount).toBe(1);

    // Every `@` query activates the issue/PR source, including ones aimed at
    // files. Those must not re-download the list.
    await activate();
    await activate();

    expect(fetchIssuesAndPRs).toHaveBeenCalledTimes(1);
    expect(itemCount).toBe(1);
  });

  it('refetches once the cached list has gone stale', async () => {
    await activate();
    expect(fetchIssuesAndPRs).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000 + 1);
    });
    await activate();

    expect(fetchIssuesAndPRs).toHaveBeenCalledTimes(2);
  });

  it('refetches immediately when the caller forces it', async () => {
    await activate();
    expect(fetchIssuesAndPRs).toHaveBeenCalledTimes(1);

    await activate({ force: true });

    expect(fetchIssuesAndPRs).toHaveBeenCalledTimes(2);
  });
});
