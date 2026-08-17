import { describe, expect, it } from 'vitest';
import { PreviewPanel } from '../src/PreviewPanel.js';
import { render } from './dom.js';

describe('PreviewPanel', () => {
  it('keeps local ports on the gateway preview path', async () => {
    const view = await render(
      <PreviewPanel target={3000} filesBase="https://box.example/workspace/" running />,
    );
    expect(view.container.querySelector('iframe')?.getAttribute('src')).toBe(
      'https://box.example/preview/3000/',
    );
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
