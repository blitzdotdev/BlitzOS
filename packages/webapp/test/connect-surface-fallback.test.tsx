import type { CatalogEntryView } from '@blitzos/schema';
import { describe, expect, it } from 'vitest';
import { ProviderConnectSurface } from '../src/connections/ProviderConnectSurface.js';
import { render } from './dom.js';

/** GitHub's shape: an OAuth round trip plus a paste path kept only for an
 * instance that has registered no app. */
function githubEntry(overrides: Partial<CatalogEntryView> = {}): CatalogEntryView {
  return {
    id: 'github',
    title: 'GitHub',
    summary: 'Repos, pull requests, and issues as you.',
    custody: 'cp',
    oauthAvailable: true,
    oauthConfigured: true,
    personalTokenLabel: 'Fine-grained personal access token',
    personalTokenFallbackOnly: true,
    personalTokenHelp: 'Scope it to the repositories the agent needs.',
    personalTokenBaseUrlLabel: null,
    adminForm: null,
    ...overrides,
  };
}

function surface(entry: CatalogEntryView, oauthHref: string | null) {
  return (
    <ProviderConnectSurface
      entry={entry}
      connectionName={entry.id}
      lockedBaseUrl={null}
      oauthHref={oauthHref}
      oauthLabel={`Connect with ${entry.title}`}
      submitLabel="Connect"
      saving={false}
      formKey="k"
      onSubmit={() => undefined}
      onCancel={() => undefined}
    />
  );
}

describe('a fallback-only paste path', () => {
  it('is hidden while the round trip is live, leaving one way in', async () => {
    const view = await render(surface(githubEntry(), '/connect/github/start'));

    // The one control: authorize as yourself.
    const connect = view.container.querySelector<HTMLAnchorElement>('a.connect-cta');
    expect(connect?.textContent).toBe('Connect with GitHub');
    expect(connect?.getAttribute('href')).toBe('/connect/github/start');

    // No token field, and no note explaining an absence the member cannot act
    // on — the button is the whole story.
    expect(view.container.querySelector('input[name="token"]')).toBeNull();
    expect(view.container.querySelector('form.connect-form')).toBeNull();
    expect(view.container.textContent).not.toContain('personal access token');
    await view.unmount();
  });

  it('comes back when the instance has registered no app', async () => {
    // oauthConfigured false is what an instance without the client id and
    // secret reports; the host then passes no href.
    const view = await render(surface(githubEntry({ oauthConfigured: false }), null));

    expect(view.container.querySelector('a.connect-cta')).toBeNull();
    expect(view.container.querySelector('input[name="token"]')).not.toBeNull();
    expect(view.container.textContent).toContain('not configured on this instance');
    await view.unmount();
  });

  it('leaves a provider whose paste path is a real choice alone', async () => {
    const view = await render(
      surface(githubEntry({ personalTokenFallbackOnly: false }), '/connect/github/start'),
    );

    // Both paths, because this provider did not declare one a fallback.
    expect(view.container.querySelector('a.connect-cta')).not.toBeNull();
    expect(view.container.querySelector('input[name="token"]')).not.toBeNull();
    await view.unmount();
  });
});
