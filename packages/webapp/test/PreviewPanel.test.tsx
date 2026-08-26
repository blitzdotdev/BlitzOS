import { describe, expect, it } from 'vitest';
import { PreviewPanel } from '../src/PreviewPanel.js';
import { TeenyappsPanel } from '../src/TeenyappsPanel.js';
import { render } from './dom.js';

function teenyapps(overrides: Partial<Parameters<typeof TeenyappsPanel>[0]> = {}) {
  return (
    <TeenyappsPanel
      orgName="Acme"
      workspaceId="workspace-one"
      livePorts={[]}
      previewLinks={[]}
      filesBase={null}
      previewReady={false}
      onOpenPreview={() => undefined}
      onOpenPreviewLink={() => undefined}
      {...overrides}
    />
  );
}

describe('PreviewPanel', () => {
  it('keeps local ports on the gateway preview path', async () => {
    const view = await render(
      <PreviewPanel target={3000} filesBase="https://box.example/workspace/" running />,
    );
    expect(view.container.querySelector('iframe')?.getAttribute('src')).toBe(
      'https://box.example/preview/3000/',
    );
    const openLink = view.container.querySelector<HTMLAnchorElement>('.preview-panel__open');
    expect(openLink?.textContent).toContain('Open');
    expect(openLink?.getAttribute('aria-label')).toBe('Open Preview :3000 in a new tab');
    expect(openLink?.getAttribute('href')).toBe('https://box.example/preview/3000/');
    expect(openLink?.getAttribute('target')).toBe('_blank');
    await view.unmount();
  });

  it('embeds allowlisted public links directly', async () => {
    const view = await render(
      <PreviewPanel
        target={{ url: 'https://demo.blitz.dev/app', title: 'Demo' }}
        filesBase={null}
        running={false}
      />,
    );
    expect(view.container.querySelector('iframe')?.getAttribute('src')).toBe(
      'https://demo.blitz.dev/app',
    );
    await view.unmount();
  });

  it('renders non-allowlisted links as a new-tab card', async () => {
    const view = await render(
      <PreviewPanel
        target={{ url: 'https://example.com/app', title: 'External app' }}
        filesBase={null}
        running={false}
      />,
    );
    expect(view.container.querySelector('iframe')).toBeNull();
    const link = view.container.querySelector<HTMLAnchorElement>('a');
    expect(link?.textContent).toContain('Open in new tab');
    expect(link?.getAttribute('href')).toBe('https://example.com/app');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener');
    await view.unmount();
  });
});

describe('TeenyappsPanel', () => {
  /** Two headings over two apologies is what a brand-new workspace used to
   * open with. An empty shared shelf is not news. */
  it('drops the org and personal sections while they hold nothing', async () => {
    const view = await render(teenyapps());
    const headings = [...view.container.querySelectorAll('.teenyapps-heading__name')]
      .map((heading) => heading.textContent);
    expect(headings).toEqual(['Local apps']);
    expect(view.container.textContent).not.toContain('Acme');
    expect(view.container.textContent).not.toContain('My teenyapps');
    // Local apps reads a live source, so its empty state stays and the pane
    // never renders blank.
    expect(view.container.textContent)
      .toContain('Ports this workspace is serving show up here while they run.');
    await view.unmount();
  });

  it('brings a section back as soon as it holds an item', async () => {
    const view = await render(teenyapps({
      previewLinks: [{
        url: 'https://demo.blitz.dev/app',
        title: 'Demo',
        source: 'workspace-one',
        createdAt: 1,
      }],
    }));
    const headings = [...view.container.querySelectorAll('.teenyapps-heading__name')]
      .map((heading) => heading.textContent);
    expect(headings).toEqual(['My teenyapps', 'Local apps']);
    expect(view.container.querySelectorAll('.teenyapps-card').length).toBe(1);
    await view.unmount();
  });
});
