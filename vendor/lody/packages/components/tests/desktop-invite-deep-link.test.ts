import { describe, expect, it } from 'vitest';
import {
  buildDesktopInviteOpenDeepLink,
  resolveDesktopInviteDeepLinkPath,
  shouldAttemptDesktopInviteHandoff,
} from '../src/lib/desktop-invite-deep-link';

describe('desktop invite deep links', () => {
  it('builds and resolves an invitation handoff', () => {
    const deepLink = buildDesktopInviteOpenDeepLink('invite/123');

    expect(deepLink).toBe('lody://invite/open?invitationId=invite%2F123');
    expect(resolveDesktopInviteDeepLinkPath(deepLink)).toBe('/invite/invite%2F123');
  });

  it('rejects malformed or unrelated deep links', () => {
    expect(resolveDesktopInviteDeepLinkPath('https://lody.ai/invite/123')).toBeNull();
    expect(resolveDesktopInviteDeepLinkPath('lody://invite/open')).toBeNull();
    expect(resolveDesktopInviteDeepLinkPath('lody://invite/accepted')).toBeNull();
    expect(resolveDesktopInviteDeepLinkPath('lody://github-install')).toBeNull();
  });
});

describe('desktop invite handoff environment', () => {
  it('only attempts the handoff from a desktop browser', () => {
    expect(
      shouldAttemptDesktopInviteHandoff({
        isElectron: false,
        isNativeAppShell: false,
        isIOSRuntime: false,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      })
    ).toBe(true);

    expect(
      shouldAttemptDesktopInviteHandoff({
        isElectron: true,
        isNativeAppShell: false,
        isIOSRuntime: false,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      })
    ).toBe(false);
    expect(
      shouldAttemptDesktopInviteHandoff({
        isElectron: false,
        isNativeAppShell: true,
        isIOSRuntime: true,
        userAgent: 'Mozilla/5.0 (iPhone)',
      })
    ).toBe(false);
    expect(
      shouldAttemptDesktopInviteHandoff({
        isElectron: false,
        isNativeAppShell: false,
        isIOSRuntime: false,
        userAgent: 'Mozilla/5.0 (Linux; Android 15)',
      })
    ).toBe(false);
    expect(
      shouldAttemptDesktopInviteHandoff({
        isElectron: false,
        isNativeAppShell: false,
        isIOSRuntime: true,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      })
    ).toBe(false);
  });
});
