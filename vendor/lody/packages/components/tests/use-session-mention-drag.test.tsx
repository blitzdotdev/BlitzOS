// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useAcceptableSessionMentionDrag } from '../src/hooks/use-session-mention-drag';
import { clearSessionMentionDrag, startSessionMentionDrag } from '../src/lib/session-mention-drag';
import { createSessionMentionTransfer } from './helpers/session-mention-transfer';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ excludeSessionId }: { excludeSessionId?: string }) {
  const active = useAcceptableSessionMentionDrag(excludeSessionId);
  return <div data-testid="armed" data-active={active ? 'yes' : 'no'} />;
}

describe('useAcceptableSessionMentionDrag', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    clearSessionMentionDrag();
    await act(async () => root.unmount());
    container.remove();
  });

  it('lights up as soon as a sidebar drag starts, and not for the open session', () => {
    act(() => {
      root.render(<Harness excludeSessionId="sess_open" />);
    });
    expect(container.querySelector('[data-testid="armed"]')?.getAttribute('data-active')).toBe(
      'no'
    );

    act(() => {
      startSessionMentionDrag(
        { dataTransfer: createSessionMentionTransfer() },
        { sessionId: 'sess_other' }
      );
    });
    expect(container.querySelector('[data-testid="armed"]')?.getAttribute('data-active')).toBe(
      'yes'
    );

    act(() => {
      startSessionMentionDrag(
        { dataTransfer: createSessionMentionTransfer() },
        { sessionId: 'sess_open' }
      );
    });
    expect(container.querySelector('[data-testid="armed"]')?.getAttribute('data-active')).toBe(
      'no'
    );

    act(() => {
      window.dispatchEvent(new Event('dragend'));
    });
    expect(container.querySelector('[data-testid="armed"]')?.getAttribute('data-active')).toBe(
      'no'
    );
  });
});
