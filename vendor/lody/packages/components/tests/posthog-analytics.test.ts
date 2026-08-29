import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  POSTHOG_INIT_PROPERTY_DENYLIST,
  POSTHOG_PROPERTY_DENYLIST,
  capturePostHogActiveUser,
  capturePostHogEvent,
  detectLaunchOsFromEnv,
  identifyPostHogWorkspace,
  sanitizePostHogProperties,
} from '../src/lib/posthog-analytics';

describe('PostHog analytics helpers', () => {
  it('removes sensitive event properties while keeping opaque analytics ids', () => {
    expect(
      sanitizePostHogProperties({
        workspace_id: 'workspace_123',
        $current_url: 'https://app.lody.ai/acme/session/session_123',
        $pathname: '/acme/session/session_123',
        $referrer: 'https://example.com/private-path',
        session_id: 'session_123',
        machine_id: 'machine_123',
        repo_full_name: 'private/repo',
        workspace_slug: 'secret-team',
        error_message: 'contains local paths and tokens',
        nested: {
          token: 'secret',
          ok: true,
        },
      })
    ).toEqual({
      workspace_id: 'workspace_123',
      session_id: 'session_123',
      machine_id: 'machine_123',
      nested: {
        ok: true,
      },
    });
  });

  it('keeps PostHog reserved transport keys out of the init property_denylist', () => {
    // posthog-js carries the project API key as `properties.token` and deletes
    // any property_denylist key *after* setting it. Denylisting `token`/`api_key`
    // at init strips the credential and ingestion rejects events with
    // "event submitted without an api_key". App scrubbing must still drop them.
    expect(POSTHOG_PROPERTY_DENYLIST).toContain('token');
    expect(POSTHOG_PROPERTY_DENYLIST).toContain('api_key');
    expect(POSTHOG_INIT_PROPERTY_DENYLIST).not.toContain('token');
    expect(POSTHOG_INIT_PROPERTY_DENYLIST).not.toContain('api_key');
    // Non-reserved sensitive keys (e.g. auto-captured URLs) must still be denied.
    expect(POSTHOG_INIT_PROPERTY_DENYLIST).toContain('$current_url');
    expect(POSTHOG_INIT_PROPERTY_DENYLIST).toContain('email');
  });

  it('captures events through sanitized properties', () => {
    const capture = vi.fn();

    capturePostHogEvent({ capture }, 'session/start_failed', {
      workspace_id: 'workspace_123',
      error_message: 'private failure',
      failure_reason: 'unknown',
    });

    expect(capture).toHaveBeenCalledWith('session/start_failed', {
      workspace_id: 'workspace_123',
      failure_reason: 'unknown',
    });
  });

  it('captures authenticated activity as the canonical DAU event', () => {
    const capture = vi.fn();

    capturePostHogActiveUser({ capture }, { user_id: 'user_123', workspace_id: 'workspace_123' });

    expect(capture).toHaveBeenCalledWith('app/active', {
      active_context: 'authenticated_app',
      user_id: 'user_123',
      workspace_id: 'workspace_123',
    });
  });

  describe('detectLaunchOsFromEnv', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('prefers the native shell platform', () => {
      vi.stubGlobal('window', { __LODY_APP_INFO__: { native_platform: 'ios' } });
      expect(detectLaunchOsFromEnv()).toBe('ios');
      vi.stubGlobal('window', { __LODY_APP_INFO__: { native_platform: 'android' } });
      expect(detectLaunchOsFromEnv()).toBe('android');
    });

    it('normalizes the electron platform os', () => {
      vi.stubGlobal('window', { __LODY_PLATFORM__: { os: 'darwin' } });
      expect(detectLaunchOsFromEnv()).toBe('macos');
      vi.stubGlobal('window', { __LODY_PLATFORM__: { os: 'win32' } });
      expect(detectLaunchOsFromEnv()).toBe('windows');
      vi.stubGlobal('window', { __LODY_PLATFORM__: { os: 'linux' } });
      expect(detectLaunchOsFromEnv()).toBe('linux');
    });

    it('falls back to the browser user agent', () => {
      vi.stubGlobal('window', {
        navigator: {
          platform: 'MacIntel',
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        },
      });
      expect(detectLaunchOsFromEnv()).toBe('macos');
      vi.stubGlobal('window', {
        navigator: {
          platform: 'iPhone',
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        },
      });
      expect(detectLaunchOsFromEnv()).toBe('ios');
    });

    it('returns unknown when no platform globals are present', () => {
      expect(detectLaunchOsFromEnv()).toBe('unknown');
    });
  });

  it('associates subsequent events with the current workspace group', () => {
    const group = vi.fn();

    identifyPostHogWorkspace({ capture: vi.fn(), group }, 'workspace_123');

    expect(group).toHaveBeenCalledWith('workspace', 'workspace_123');
  });
});
