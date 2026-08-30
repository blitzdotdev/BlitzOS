// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WebChatLandingScreen } from '../src/components/chat/web-chat-landing-screen';
import { SessionConversationPage } from '../src/components/sessions/session-conversation-page';
import { ConversationDropOverlay } from '../src/components/shared/conversation-drop-overlay';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ConversationDropOverlay', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('is absent until an accepted drag is over the surface', () => {
    act(() => {
      root.render(<ConversationDropOverlay active={false} />);
    });
    expect(container.querySelector('[data-testid="conversation-drop-overlay"]')).toBeNull();
  });

  it('paints a mention mask on the landing and the conversation page', () => {
    act(() => {
      root.render(
        <WebChatLandingScreen
          title="Let's ship something"
          dropActive
          composer={<div>composer</div>}
        />
      );
    });
    const landing = container.querySelector('[data-testid="conversation-drop-overlay"]');
    expect(landing).not.toBeNull();
    expect(landing?.getAttribute('data-drop-kind')).toBe('session-mention');
    expect(landing?.textContent).toContain('Drop to mention this conversation');

    act(() => {
      root.render(
        <SessionConversationPage dropActive dropKind="files">
          <div>session</div>
        </SessionConversationPage>
      );
    });
    const session = container.querySelector('[data-testid="conversation-drop-overlay"]');
    expect(session).not.toBeNull();
    expect(session?.getAttribute('data-drop-kind')).toBe('files');
    expect(session?.textContent).toContain('Drop to attach');
  });
});
