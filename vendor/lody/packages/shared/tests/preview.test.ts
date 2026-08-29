import { describe, expect, it } from 'vitest';

import {
  PREVIEW_ACCESS_TOKEN_COOKIE,
  PREVIEW_ACCESS_TOKEN_QUERY_PARAM,
  PREVIEW_EMBEDDER_POLICY,
  PREVIEW_RESOURCE_POLICY,
  PREVIEW_TUNNEL_HTTP_BODY_BATCH_BYTES,
  PREVIEW_TUNNEL_PROTOCOL_VERSION,
  PREVIEW_TUNNEL_RESPONSE_BODY_CREDIT_WINDOW_BYTES,
  PREVIEW_TUNNEL_SOCKET_BACKPRESSURE_HIGH_WATERMARK_BYTES,
  PREVIEW_TUNNEL_SOCKET_BACKPRESSURE_LOW_WATERMARK_BYTES,
  DEFAULT_PREVIEW_RESOURCE_LIMITS,
  applyPreviewEmbeddingHeaders,
  buildPreviewAccessTokenCookie,
  buildPreviewPublicUrl,
  hasReportedPreviewTarget,
  isPreviewTunnelCreateResponse,
  isAllowedPreviewPublicUrl,
  normalizePreviewPublicBaseDomain,
  parsePreviewTunnelClientMessage,
  parsePreviewTunnelServerMessage,
  removePreviewAccessTokenFromSearch,
  removePreviewQueryParamFromSearch,
  sanitizePreviewProxyResponseHeaders,
  setPreviewQueryParamInUrl,
  stripPreviewFrameAncestorsDirective,
} from '../src/preview';

describe('preview tunnel transport profile', () => {
  it('keeps body batches bounded while allowing multiple batches in flight', () => {
    expect(PREVIEW_TUNNEL_PROTOCOL_VERSION).toBe(3);
    expect(PREVIEW_TUNNEL_HTTP_BODY_BATCH_BYTES).toBeGreaterThanOrEqual(256 * 1024);
    expect(PREVIEW_TUNNEL_HTTP_BODY_BATCH_BYTES).toBeLessThan(32 * 1024 * 1024);
    expect(PREVIEW_TUNNEL_RESPONSE_BODY_CREDIT_WINDOW_BYTES).toBeGreaterThanOrEqual(
      PREVIEW_TUNNEL_HTTP_BODY_BATCH_BYTES * 2
    );
    expect(
      PREVIEW_TUNNEL_RESPONSE_BODY_CREDIT_WINDOW_BYTES % PREVIEW_TUNNEL_HTTP_BODY_BATCH_BYTES
    ).toBe(0);
    expect(PREVIEW_TUNNEL_SOCKET_BACKPRESSURE_LOW_WATERMARK_BYTES).toBeGreaterThanOrEqual(
      PREVIEW_TUNNEL_HTTP_BODY_BATCH_BYTES
    );
    expect(PREVIEW_TUNNEL_SOCKET_BACKPRESSURE_HIGH_WATERMARK_BYTES).toBeGreaterThan(
      PREVIEW_TUNNEL_SOCKET_BACKPRESSURE_LOW_WATERMARK_BYTES
    );
  });
});

describe('preview public URLs', () => {
  it('accepts generated managed preview URLs', () => {
    const url = buildPreviewPublicUrl({
      sessionId: 'session_abc123',
      grantId: 'grant_def456',
    });

    expect(isAllowedPreviewPublicUrl(url)).toBe(true);
  });

  it('accepts managed preview URLs with a bootstrap access token', () => {
    const url = new URL(
      buildPreviewPublicUrl({
        sessionId: 'session_abc123',
        grantId: 'grant_def456',
      })
    );
    url.searchParams.set(PREVIEW_ACCESS_TOKEN_QUERY_PARAM, 'preview-token');

    expect(isAllowedPreviewPublicUrl(url.toString())).toBe(true);
  });

  it('supports an explicitly configured preview base domain', () => {
    const url = buildPreviewPublicUrl({
      sessionId: 'session_abc123',
      grantId: 'grant_def456',
      baseDomain: 'LODY.UK',
    });

    expect(url).toBe('https://session-grantde.lody.uk');
    expect(isAllowedPreviewPublicUrl(url, 'lody.uk')).toBe(true);
    expect(isAllowedPreviewPublicUrl(url, 'mylody.app')).toBe(false);
  });

  it.each([
    '',
    'localhost',
    'https://lody.uk',
    '*.lody.uk',
    'lody.uk:443',
    'lody.uk/path',
    'lody.uk.',
    '127.0.0.1',
  ])('rejects invalid preview base domain %j', (domain) => {
    expect(() => normalizePreviewPublicBaseDomain(domain)).toThrow(
      'Preview public base domain must be an ASCII public base domain'
    );
  });

  it('rejects non-managed preview URLs', () => {
    expect(isAllowedPreviewPublicUrl('https://mylody.app')).toBe(false);
    expect(isAllowedPreviewPublicUrl('http://abc.mylody.app')).toBe(false);
    expect(isAllowedPreviewPublicUrl('https://abc.mylody.app:444')).toBe(false);
    expect(isAllowedPreviewPublicUrl('https://mylody.app.evil.test')).toBe(false);
    expect(isAllowedPreviewPublicUrl('https://a.b.mylody.app')).toBe(false);
    expect(isAllowedPreviewPublicUrl('https://user:pass@abc.mylody.app')).toBe(false);
  });
});

describe('preview access token cookie', () => {
  it('removes preview access tokens without normalizing Vite bare query params', () => {
    expect(
      removePreviewAccessTokenFromSearch(
        '?vue&type=style&index=0&lang.css&__lody_preview_token=preview-token'
      )
    ).toBe('?vue&type=style&index=0&lang.css');
    expect(
      removePreviewAccessTokenFromSearch(
        '?__lody_preview_token=preview-token&vue&type=style&index=0&lang.css'
      )
    ).toBe('?vue&type=style&index=0&lang.css');
    expect(removePreviewAccessTokenFromSearch('?__lody_preview_token=preview-token')).toBe('');
  });

  it('adds and removes preview capabilities without normalizing bare query params', () => {
    const viewerUrl = setPreviewQueryParamInUrl(
      new URL(
        'http://127.0.0.1:5173/DownloadPage.vue?vue&type=style&index=0&lang.css&__lody_local_preview_token=stale'
      ),
      '__lody_local_preview_token',
      'local token'
    );

    expect(viewerUrl.toString()).toBe(
      'http://127.0.0.1:5173/DownloadPage.vue?vue&type=style&index=0&lang.css&__lody_local_preview_token=local%20token'
    );
    expect(removePreviewQueryParamFromSearch(viewerUrl.search, '__lody_local_preview_token')).toBe(
      '?vue&type=style&index=0&lang.css'
    );
  });

  it('uses partitioned third-party cookie attributes for embedded previews', () => {
    const now = 1_800_000;
    const cookie = buildPreviewAccessTokenCookie({
      token: 'preview token/with+chars',
      expiresAt: now + 120_000,
      now,
    });

    expect(cookie).toBe(
      `${PREVIEW_ACCESS_TOKEN_COOKIE}=preview%20token%2Fwith%2Bchars; Max-Age=120; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`
    );
  });

  it('clamps preview access token cookie max-age', () => {
    const now = 1_800_000;

    expect(
      buildPreviewAccessTokenCookie({
        token: 'preview-token',
        expiresAt: now + 12 * 60 * 60 * 1000,
        now,
      })
    ).toContain('Max-Age=28800');
    expect(
      buildPreviewAccessTokenCookie({
        token: 'preview-token',
        expiresAt: now - 1_000,
        now,
      })
    ).toContain('Max-Age=60');
  });
});

describe('preview proxy response headers', () => {
  it('removes frame embedding blockers while preserving other response headers', () => {
    expect(
      sanitizePreviewProxyResponseHeaders([
        ['Content-Type', 'text/html; charset=utf-8'],
        ['X-Frame-Options', 'SAMEORIGIN'],
        [
          'Content-Security-Policy',
          "default-src 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'",
        ],
        ['Content-Security-Policy-Report-Only', "frame-ancestors 'none'"],
      ])
    ).toEqual([
      ['Content-Type', 'text/html; charset=utf-8'],
      ['Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'"],
      ['Content-Security-Policy-Report-Only', "frame-ancestors 'none'"],
    ]);
  });

  it('drops content-security-policy when only frame-ancestors remains', () => {
    expect(
      sanitizePreviewProxyResponseHeaders([
        ['content-security-policy', "frame-ancestors 'self'"],
        ['x-frame-options', 'DENY'],
        ['cache-control', 'no-store'],
      ])
    ).toEqual([['cache-control', 'no-store']]);
  });

  it('strips frame-ancestors case-insensitively from a CSP value', () => {
    expect(
      stripPreviewFrameAncestorsDirective(
        "  FRAME-ANCESTORS https://example.com ; default-src 'self';"
      )
    ).toBe("default-src 'self'");
  });
});

describe('preview embedding headers', () => {
  it('sets COEP/CORP that match the embedder app policy', () => {
    const headers = applyPreviewEmbeddingHeaders(new Headers());
    expect(headers.get('Cross-Origin-Embedder-Policy')).toBe(PREVIEW_EMBEDDER_POLICY);
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe(PREVIEW_RESOURCE_POLICY);
    expect(PREVIEW_EMBEDDER_POLICY).toBe('credentialless');
    expect(PREVIEW_RESOURCE_POLICY).toBe('cross-origin');
  });

  it('overrides any pre-existing embedder/resource policy from the upstream response', () => {
    const headers = applyPreviewEmbeddingHeaders(
      new Headers({
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Type': 'text/html',
      })
    );
    expect(headers.get('Cross-Origin-Embedder-Policy')).toBe('credentialless');
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(headers.get('Content-Type')).toBe('text/html');
  });
});

describe('preview tunnel resource limits', () => {
  it('accepts create responses with resource limits', () => {
    expect(
      isPreviewTunnelCreateResponse({
        tunnelId: 'session-grant',
        publicUrl: 'https://session-grant.mylody.app',
        websocketUrl: 'wss://api.example.com/api/preview/tunnels/session-grant/connect?token=abc',
        sessionToken: 'session-token',
        expiresAt: 1_800_000,
        resourceLimits: DEFAULT_PREVIEW_RESOURCE_LIMITS,
      })
    ).toBe(true);
  });

  it('rejects malformed resource limits in create responses', () => {
    expect(
      isPreviewTunnelCreateResponse({
        tunnelId: 'session-grant',
        publicUrl: 'https://session-grant.mylody.app',
        websocketUrl: 'wss://api.example.com/api/preview/tunnels/session-grant/connect?token=abc',
        sessionToken: 'session-token',
        expiresAt: 1_800_000,
        resourceLimits: {
          ...DEFAULT_PREVIEW_RESOURCE_LIMITS,
          maxRequestBodyBytes: 0,
        },
      })
    ).toBe(false);
  });
});

describe('preview tunnel protocol messages', () => {
  it('parses valid server messages', () => {
    expect(
      parsePreviewTunnelServerMessage(
        JSON.stringify({
          type: 'request-start',
          requestId: 'request-1',
          method: 'GET',
          url: '/@vite/client',
          headers: [['accept', '*/*']],
          hasBody: false,
          binaryPayload: true,
          responseBodyCredit: true,
        })
      )
    ).toMatchObject({ type: 'request-start', requestId: 'request-1' });
  });

  it('rejects malformed server messages', () => {
    expect(
      parsePreviewTunnelServerMessage(
        JSON.stringify({
          type: 'response-body-credit',
          requestId: 'request-1',
          credit: 0,
        })
      )
    ).toBeNull();
    expect(parsePreviewTunnelServerMessage('not json')).toBeNull();
  });

  it('parses valid client messages', () => {
    expect(
      parsePreviewTunnelClientMessage(
        JSON.stringify({
          type: 'client-ready',
          protocolVersion: PREVIEW_TUNNEL_PROTOCOL_VERSION,
          capabilities: [],
        })
      )
    ).toMatchObject({ type: 'client-ready' });
  });

  it('rejects malformed client messages', () => {
    expect(
      parsePreviewTunnelClientMessage(
        JSON.stringify({
          type: 'response-start',
          requestId: 'request-1',
          status: 200,
          statusText: 'OK',
          headers: [['set-cookie']],
          hasBody: false,
        })
      )
    ).toBeNull();
  });
});

describe('preview entry point availability', () => {
  it('stays hidden until the agent reports a candidate', () => {
    expect(hasReportedPreviewTarget({})).toBe(false);
    expect(hasReportedPreviewTarget({ candidateStatus: 'none' })).toBe(false);
    // A rejected report (non-loopback host, dead port, …) is not a target.
    expect(hasReportedPreviewTarget({ candidateStatus: 'invalid' })).toBe(false);
    // An idle/finished connection alone leaves nothing to open.
    expect(hasReportedPreviewTarget({ connectionStatus: 'idle' })).toBe(false);
    expect(hasReportedPreviewTarget({ connectionStatus: 'revoked' })).toBe(false);
    expect(hasReportedPreviewTarget({ connectionStatus: 'expired' })).toBe(false);
    expect(hasReportedPreviewTarget({ connectionStatus: 'failed' })).toBe(false);
  });

  it('appears for a reported candidate or a live connection', () => {
    expect(hasReportedPreviewTarget({ candidateStatus: 'reported' })).toBe(true);
    expect(hasReportedPreviewTarget({ candidateStatus: 'validating' })).toBe(true);
    expect(hasReportedPreviewTarget({ candidateStatus: 'available' })).toBe(true);
    // A live connection survives a candidate that was cleared or invalidated.
    expect(
      hasReportedPreviewTarget({ candidateStatus: 'invalid', connectionStatus: 'active' })
    ).toBe(true);
    expect(hasReportedPreviewTarget({ connectionStatus: 'creating' })).toBe(true);
  });
});
