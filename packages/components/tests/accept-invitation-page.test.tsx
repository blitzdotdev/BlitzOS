// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AcceptInvitationPage } from '../src/components/pages/accept-invitation-page';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('AcceptInvitationPage directed invitation states', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('keeps invitation context visible before the recipient signs in', async () => {
    const onContinue = vi.fn();
    await act(async () => {
      root?.render(
        <AcceptInvitationPage
          state="auth_required"
          invitationOrganizationName="PKU Research Lab"
          inviterName="Ada"
          recipientEmailMasked="h***@nsd.pku.edu.cn"
          invitationRole="member"
          onContinue={onContinue}
        />
      );
    });

    expect(container?.textContent).toContain('PKU Research Lab');
    expect(container?.textContent).toContain('Ada invited you to collaborate.');
    expect(container?.textContent).toContain('h***@nsd.pku.edu.cn');
    expect(container?.textContent).toContain('Role: Member');

    const continueButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Continue with invited email')
    );
    await act(async () => continueButton?.click());
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('explains an account mismatch and offers an account switch', async () => {
    const onSwitchAccount = vi.fn();
    await act(async () => {
      root?.render(
        <AcceptInvitationPage
          state="account_mismatch"
          invitationOrganizationName="PKU Research Lab"
          recipientEmailMasked="h***@nsd.pku.edu.cn"
          invitationRole="member"
          currentUserEmail="personal@example.com"
          onSwitchAccount={onSwitchAccount}
        />
      );
    });

    expect(container?.textContent).toContain('h***@nsd.pku.edu.cn');
    expect(container?.textContent).toContain('personal@example.com');
    expect(container?.textContent).toContain('Invitation to PKU Research Lab');
    expect(container?.textContent).toContain('Role: Member');
    expect(container?.textContent).not.toContain('Invitation not found or expired');

    const switchButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Switch account')
    );
    await act(async () => switchButton?.click());
    expect(onSwitchAccount).toHaveBeenCalledOnce();
  });

  it('gives an unverified recipient a verification path', async () => {
    const onVerifyEmail = vi.fn();
    await act(async () => {
      root?.render(
        <AcceptInvitationPage state="verification_required" onVerifyEmail={onVerifyEmail} />
      );
    });

    expect(container?.textContent).toContain('Verify the invited email');
    const verifyButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Continue to verification')
    );
    await act(async () => verifyButton?.click());
    expect(onVerifyEmail).toHaveBeenCalledOnce();
  });
});
