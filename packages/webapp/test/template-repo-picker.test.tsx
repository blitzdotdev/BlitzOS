import type { GithubRepositoryView, ListGithubRepositoriesResponse } from '@blitzos/schema';
import { useState } from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TemplateRepoPicker } from '../src/files/TemplateRepoPicker';
import { render, settle } from './dom';

const INSTALLATION: GithubRepositoryView[] = [{ fullName: 'acme/app', private: false }];

/** Passes a brand-new onRepositories arrow on every render, which is what a
 * caller writes by default. If the picker's effect ever depends on that
 * identity, the listing refetches forever and the page stops taking input. */
function UnstableCaller({ client }: { client: { listGithubRepositories(): Promise<ListGithubRepositoriesResponse> } }) {
  const [covered, setCovered] = useState<string[]>([]);
  return (
    <>
      <p data-testid="covered">{covered.join(',')}</p>
      <TemplateRepoPicker
        client={client}
        admin
        githubConfigured
        value={[]}
        onChange={() => undefined}
        onRepositories={(loaded) => { setCovered(loaded.map(({ fullName }) => fullName)); }}
      />
    </>
  );
}

describe('TemplateRepoPicker', () => {
  it('fetches the listing once even when onRepositories is a new function each render', async () => {
    const listGithubRepositories = vi.fn(
      (): Promise<ListGithubRepositoriesResponse> => Promise.resolve({ repositories: INSTALLATION }),
    );

    const view = await render(<UnstableCaller client={{ listGithubRepositories }} />);
    await settle();
    // A render loop would keep refetching, so give it several turns to show up.
    for (let turn = 0; turn < 5; turn += 1) await settle();

    expect(listGithubRepositories).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[data-testid="covered"]')?.textContent).toBe('acme/app');
    await view.unmount();
  });

  it('publishes the latest onRepositories, not the one from the first render', async () => {
    let resolveListing: (response: ListGithubRepositoriesResponse) => void = () => undefined;
    const listGithubRepositories = vi.fn(
      (): Promise<ListGithubRepositoriesResponse> =>
        new Promise((resolve) => { resolveListing = resolve; }),
    );
    const first = vi.fn();
    const second = vi.fn();
    // One client identity across both renders: `client` is a real dependency,
    // so a fresh object would refetch for a reason this test is not about.
    const client = { listGithubRepositories };

    const view = await render(
      <TemplateRepoPicker
        client={client}
        admin
        githubConfigured
        value={[]}
        onChange={() => undefined}
        onRepositories={first}
      />,
    );
    // The caller re-renders with a different handler while the listing is open.
    await act(async () => {
      view.root.render(
        <TemplateRepoPicker
          client={client}
          admin
          githubConfigured
          value={[]}
          onChange={() => undefined}
          onRepositories={second}
        />,
      );
    });
    await act(async () => { resolveListing({ repositories: INSTALLATION }); });
    await settle();

    expect(listGithubRepositories).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(INSTALLATION);
    await view.unmount();
  });
});
