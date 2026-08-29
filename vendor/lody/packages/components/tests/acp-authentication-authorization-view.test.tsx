// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AcpAuthenticationAuthorizationView } from '../src/components/settings/acp-authentication-panel';
import { initI18n } from '../src/i18n';

describe('AcpAuthenticationAuthorizationView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows and exposes the device authorization actions without terminal output', async () => {
    const onOpenAuthorization = vi.fn();
    const onCopyUserCode = vi.fn();

    await act(async () => {
      root.render(
        <AcpAuthenticationAuthorizationView
          provider="ChatGPT"
          authorization={{
            authorizationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'DQGR-SB46E',
            expiresInSeconds: 900,
          }}
          authorizationCode=""
          authorizationCodeSubmitted={false}
          submittingAuthorizationCode={false}
          userCodeCopied={false}
          onOpenAuthorization={onOpenAuthorization}
          onCopyUserCode={onCopyUserCode}
          onAuthorizationCodeChange={vi.fn()}
          onSubmitAuthorizationCode={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain('Finish signing in to ChatGPT');
    expect(container.textContent).toContain('DQGR-SB46E');
    expect(container.textContent).toContain('15 minutes');
    expect(container.querySelector('pre')).toBeNull();

    const buttons = Array.from(container.querySelectorAll('button'));
    const openButton = buttons.find((button) => button.textContent?.includes('Open authorization'));
    const copyButton = buttons.find((button) => button.textContent?.includes('Copy code'));
    expect(openButton).toBeDefined();
    expect(copyButton).toBeDefined();

    await act(async () => {
      openButton?.click();
      copyButton?.click();
    });
    expect(onOpenAuthorization).toHaveBeenCalledOnce();
    expect(onCopyUserCode).toHaveBeenCalledOnce();
  });

  it('submits the Claude browser-returned code from the Lody form', async () => {
    const onSubmitAuthorizationCode = vi.fn();

    await act(async () => {
      root.render(
        <AcpAuthenticationAuthorizationView
          provider="Claude"
          authorization={{
            authorizationUrl: 'https://claude.com/cai/oauth/authorize?client_id=test',
            acceptsAuthorizationCode: true,
          }}
          authorizationCode="browser-returned-code"
          authorizationCodeSubmitted={false}
          submittingAuthorizationCode={false}
          userCodeCopied={false}
          onOpenAuthorization={vi.fn()}
          onCopyUserCode={vi.fn()}
          onAuthorizationCodeChange={vi.fn()}
          onSubmitAuthorizationCode={onSubmitAuthorizationCode}
        />
      );
    });

    const input = container.querySelector<HTMLInputElement>('input');
    expect(input?.value).toBe('browser-returned-code');
    const continueButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Continue')
    );
    expect(continueButton).toBeDefined();

    await act(async () => {
      continueButton?.click();
    });
    expect(onSubmitAuthorizationCode).toHaveBeenCalledOnce();
  });
});
