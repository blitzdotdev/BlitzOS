import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_LOCATION_MESSAGE, BrowserPanel } from '../src/browser/BrowserPanel.js';
import type { BrowserTarget } from '../src/browser/browser-target.js';
import { render } from './dom.js';

const filesBase = 'https://app.example/workspaces/ws-1/webapp/7445/workspace/';

function frame(container: HTMLElement): HTMLIFrameElement | null {
  return container.querySelector('iframe.blitz-browser__frame');
}

function address(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('.blitz-browser__address');
  if (input === null) throw new Error('no address bar');
  return input;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('BrowserPanel', () => {
  it('starts empty and explains the two ways in', async () => {
    const view = await render(<BrowserPanel target={null} filesBase={filesBase} onNavigate={() => undefined} />);
    expect(frame(view.container)).toBeNull();
    expect(view.container.textContent).toContain('blitz browser open');
    await view.unmount();
  });

  it('frames a port through the gateway and reports a typed address', async () => {
    const onNavigate = vi.fn();
    const view = await render(
      <BrowserPanel target={{ kind: 'port', port: 3000, path: '/' }} filesBase={filesBase} onNavigate={onNavigate} />,
    );
    expect(frame(view.container)?.getAttribute('src'))
      .toBe('https://app.example/workspaces/ws-1/webapp/7445/preview/3000/');
    expect(address(view.container).value).toBe('localhost:3000');

    await type(address(view.container), 'site/index.html');
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'file', file: '/workspace/site/index.html' });
    await view.unmount();
  });

  it('keeps its own history and asks the shell to go back', async () => {
    const onNavigate = vi.fn();
    const first: BrowserTarget = { kind: 'port', port: 3000, path: '/' };
    const second: BrowserTarget = { kind: 'file', file: '/workspace/x.html' };
    const view = await render(<BrowserPanel target={first} filesBase={filesBase} onNavigate={onNavigate} />);
    const back = () => view.container.querySelector<HTMLButtonElement>('button[aria-label="Back"]');
    expect(back()?.disabled).toBe(true);
    await act(async () => {
      view.root.render(<BrowserPanel target={second} filesBase={filesBase} onNavigate={onNavigate} />);
    });
    expect(back()?.disabled).toBe(false);
    await act(async () => back()?.click());
    expect(onNavigate).toHaveBeenCalledWith(first);
    await view.unmount();
  });

  it('shows an app frame, and follows the bridge message into the address bar', async () => {
    const view = await render(
      <BrowserPanel
        target={{ kind: 'url', url: 'https://demo.app.teenyapp.com/' }}
        filesBase={filesBase}
        onNavigate={() => undefined}
      />,
    );
    const app = frame(view.container);
    expect(app?.getAttribute('src')).toBe('https://demo.app.teenyapp.com/');
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: BROWSER_LOCATION_MESSAGE, href: 'https://demo.app.teenyapp.com/settings' },
        source: app?.contentWindow,
      }));
    });
    expect(address(view.container).value).toBe('https://demo.app.teenyapp.com/settings');
    await view.unmount();
  });

  it('refuses a host it does not embed and offers a new tab instead', async () => {
    const view = await render(
      <BrowserPanel target={{ kind: 'url', url: 'https://example.com/' }} filesBase={filesBase} onNavigate={() => undefined} />,
    );
    expect(frame(view.container)).toBeNull();
    expect(view.container.querySelector('a[href="https://example.com/"]')).not.toBeNull();
    await view.unmount();
  });
});
