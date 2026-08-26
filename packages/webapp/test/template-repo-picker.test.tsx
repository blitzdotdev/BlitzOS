import type { GithubRepositoryView, ListGithubRepositoriesResponse } from '@blitzos/schema';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TemplateRepoPicker } from '../src/files/TemplateRepoPicker';
import { render, settle } from './dom';

const INSTALLATION: GithubRepositoryView[] = [{ fullName: 'acme/app', private: false }];

function Caller({
  client,
  renderNumber,
}: {
  client: { listGithubRepositories(): Promise<ListGithubRepositoriesResponse> };
  renderNumber: number;
}) {
  return (
    <>
      <p data-testid="render-number">{renderNumber}</p>
      <TemplateRepoPicker
        client={client}
        value={[]}
        onChange={() => undefined}
      />
    </>
  );
}

describe('TemplateRepoPicker', () => {
  it('fetches the listing once across re-renders', async () => {
    const listGithubRepositories = vi.fn(
      (): Promise<ListGithubRepositoriesResponse> => Promise.resolve({ repositories: INSTALLATION }),
    );
    const client = { listGithubRepositories };

    const view = await render(<Caller client={client} renderNumber={0} />);
    await settle();
    // Keep the client stable so only a newly unstable dependency can refetch.
    for (let turn = 1; turn <= 5; turn += 1) {
      await act(async () => {
        view.root.render(<Caller client={client} renderNumber={turn} />);
      });
      await settle();
    }

    expect(listGithubRepositories).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[data-testid="render-number"]')?.textContent).toBe('5');
    await view.unmount();
  });
});
