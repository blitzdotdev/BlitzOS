// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceJoinRequestPage } from '../src/components/pages/workspace-join-request-page';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const handlers = {
  onReasonChange: vi.fn(),
  onContinue: vi.fn(),
  onVerifyEmail: vi.fn(),
  onSubmit: vi.fn(),
  onOpenWorkspace: vi.fn(),
  onBackHome: vi.fn(),
};

describe('WorkspaceJoinRequestPage', () => {
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
    vi.clearAllMocks();
  });

  it('explains that an open link accepts any verified account', async () => {
    await act(async () => {
      root.render(
        <WorkspaceJoinRequestPage
          {...handlers}
          state="auth_required"
          workspaceName="PKU Research Lab"
          reason=""
        />
      );
    });
    expect(container.textContent).toContain('PKU Research Lab');
    expect(container.textContent).toContain('any verified email');
  });

  it('shows the server-owned identity and requires a reason', async () => {
    await act(async () => {
      root.render(
        <WorkspaceJoinRequestPage
          {...handlers}
          state="form"
          workspaceName="PKU Research Lab"
          currentEmail="hello@nsd.pku.edu.cn"
          reason=""
        />
      );
    });
    expect(container.textContent).toContain('Submitting as hello@nsd.pku.edu.cn');
    const submit = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Submit request')
    );
    expect(submit?.disabled).toBe(true);
  });
});
