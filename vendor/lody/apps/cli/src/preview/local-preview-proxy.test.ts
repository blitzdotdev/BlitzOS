import http, { type AddressInfo } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreviewTarget, SessionId } from '@lody/shared';
import { LocalPreviewProxyManager } from './local-preview-proxy';

const createLogger = () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  setDebug: () => {},
  child: () => createLogger(),
  close: () => {},
});

const listenHtmlServer = async (): Promise<{
  server: http.Server;
  target: PreviewTarget;
  requestUrls: string[];
  styleReferers: Array<string | undefined>;
}> => {
  const requestUrls: string[] = [];
  const styleReferers: Array<string | undefined> = [];
  const server = http.createServer((request, response) => {
    requestUrls.push(request.url ?? '');
    if (request.url?.startsWith('/external-redirect')) {
      response.writeHead(302, { location: 'https://example.com/outside' });
      response.end();
      return;
    }
    if (request.url?.startsWith('/@tanstack-start/styles.css')) {
      styleReferers.push(request.headers.referer);
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end('body { color: rgb(1, 2, 3); }');
      return;
    }
    if (request.url?.startsWith('/@react-refresh')) {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end('export const RefreshRuntime = {};');
      return;
    }
    if (request.url?.startsWith('/DownloadPage.vue')) {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end('.download { display: block; }');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html><body><button data-testid="cta">Review</button></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected HTTP server to listen on a TCP port');
  }
  return {
    server,
    target: {
      protocol: 'http',
      host: '127.0.0.1',
      port: (address as AddressInfo).port,
    },
    requestUrls,
    styleReferers,
  };
};

describe('LocalPreviewProxyManager', () => {
  const servers: http.Server[] = [];
  const managers: LocalPreviewProxyManager[] = [];

  afterEach(async () => {
    await Promise.allSettled(managers.splice(0).map((manager) => manager.closeAll('test cleanup')));
    await Promise.allSettled(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
  });

  it('serves local preview HTML through an annotated ephemeral proxy endpoint', async () => {
    const { server, target, requestUrls, styleReferers } = await listenHtmlServer();
    servers.push(server);
    const manager = new LocalPreviewProxyManager({
      logger: createLogger(),
      now: () => 1_714_438_400_000,
    });
    managers.push(manager);

    const endpoint = await manager.acquire({
      sessionId: 'session-preview-proxy' as SessionId,
      target,
      shareUrl: 'https://session-preview.mylody.app',
    });

    expect(endpoint.kind).toBe('local-proxy');
    expect(endpoint.shareUrl).toBe('https://session-preview.mylody.app');
    expect(endpoint.capabilities).toEqual({ visualAnnotation: true, shareable: true });

    const assetUrl = new URL(
      '/@tanstack-start/styles.css?routes=__root__%2C%2F',
      endpoint.viewerUrl
    );
    const lockedAssetResponse = await fetch(assetUrl, {
      headers: {
        referer: new URL('/src/main.tsx', endpoint.viewerUrl).toString(),
      },
    });
    expect(lockedAssetResponse.status).toBe(403);

    const response = await fetch(endpoint.viewerUrl);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('data-lody-visual-annotation-runtime="true"');
    expect(html).toContain('window.__lodyVisualCommentInspector');

    const unauthenticatedAssetResponse = await fetch(assetUrl);
    expect(unauthenticatedAssetResponse.status).toBe(403);

    const refererAuthorizedAssetResponse = await fetch(assetUrl, {
      headers: {
        referer: endpoint.viewerUrl,
      },
    });
    expect(refererAuthorizedAssetResponse.status).toBe(200);
    expect(await refererAuthorizedAssetResponse.text()).toContain('rgb(1, 2, 3)');
    expect(styleReferers).toEqual([`http://127.0.0.1:${target.port}/`]);

    const reactRefreshUrl = new URL('/@react-refresh', endpoint.viewerUrl);
    const moduleChainAssetResponse = await fetch(reactRefreshUrl, {
      headers: {
        referer: new URL('/src/main.tsx', endpoint.viewerUrl).toString(),
      },
    });
    expect(moduleChainAssetResponse.status).toBe(200);
    expect(await moduleChainAssetResponse.text()).toContain('RefreshRuntime');

    const viteStyleUrl = new URL(
      '/DownloadPage.vue?vue&type=style&index=0&lang.css',
      endpoint.viewerUrl
    );
    const viteStyleResponse = await fetch(viteStyleUrl, {
      headers: { referer: endpoint.viewerUrl },
    });
    expect(viteStyleResponse.status).toBe(200);
    expect(await viteStyleResponse.text()).toContain('.download');
    expect(requestUrls).toContain('/DownloadPage.vue?vue&type=style&index=0&lang.css');

    const crossSiteAssetResponse = await fetch(reactRefreshUrl, {
      headers: {
        referer: 'https://attacker.example/app',
      },
    });
    expect(crossSiteAssetResponse.status).toBe(403);

    await manager.release('session-preview-proxy' as SessionId, endpoint.endpointId);
    await expect(fetch(endpoint.viewerUrl)).rejects.toThrow();
  });

  it('keeps one session-owned proxy endpoint until it is explicitly released', async () => {
    const { server, target } = await listenHtmlServer();
    servers.push(server);
    const manager = new LocalPreviewProxyManager({ logger: createLogger() });
    managers.push(manager);
    const sessionId = 'session-preview-navigation' as SessionId;

    const first = await manager.acquire({ sessionId, target: { ...target, path: '/first' } });
    const second = await manager.acquire({
      sessionId,
      target: {
        ...target,
        path: '/DownloadPage.vue?vue&type=style&index=0&lang.css#members',
      },
    });

    expect(second.endpointId).toBe(first.endpointId);
    const secondViewerUrl = new URL(second.viewerUrl);
    const localToken = secondViewerUrl.searchParams.get('__lody_local_preview_token');
    expect(localToken).not.toBeNull();
    expect(secondViewerUrl).toMatchObject({
      pathname: '/DownloadPage.vue',
      search: `?vue&type=style&index=0&lang.css&__lody_local_preview_token=${localToken}`,
      hash: '#members',
    });

    await manager.release(sessionId, first.endpointId);
    await expect(fetch(second.viewerUrl)).rejects.toThrow();
  });

  it('rejects redirects that leave the bound target origin', async () => {
    const { server, target } = await listenHtmlServer();
    servers.push(server);
    const manager = new LocalPreviewProxyManager({ logger: createLogger() });
    managers.push(manager);

    const endpoint = await manager.acquire({
      sessionId: 'session-preview-external-redirect' as SessionId,
      target: { ...target, path: '/external-redirect' },
    });
    const response = await fetch(endpoint.viewerUrl, { redirect: 'manual' });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain('Preview proxy error');
  });
});
