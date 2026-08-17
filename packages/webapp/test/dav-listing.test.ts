import { describe, expect, it } from 'vitest';
import { createClient, getPatcher, type FileStat } from 'webdav';
import { listedNodes } from '../src/files-tree.js';
import { FILES_DAV_ROOT } from '../src/resolver.js';

// The webdav node build fetches through its patcher hook, not global fetch.
let routes: Record<string, { href: string; dir: boolean }[]> = {};
getPatcher().patch('fetch', async (...args: unknown[]) => {
  const input = args[0] as string | URL;
  const url = new URL(String(input));
  const listing = routes[url.pathname.replace(/\/+$/u, '')];
  if (listing === undefined) return new Response('not found', { status: 404 });
  return new Response(multistatus(listing), {
    status: 207,
    headers: { 'Content-Type': 'application/xml' },
  });
});

/** dufs answers PROPFIND with hrefs rooted at the guest's /workspace — it
 * never sees the control-plane proxy prefix in front of it. */
function multistatus(hrefs: { href: string; dir: boolean }[]): string {
  const responses = hrefs.map(({ href, dir }) => `
    <D:response>
      <D:href>${href}</D:href>
      <D:propstat>
        <D:prop>
          <D:displayname></D:displayname>
          <D:resourcetype>${dir ? '<D:collection/>' : ''}</D:resourcetype>
          ${dir ? '' : '<D:getcontentlength>12</D:getcontentlength>'}
          <D:getlastmodified>Sun, 16 Aug 2026 00:00:00 GMT</D:getlastmodified>
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
    <D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`;
}

function stubPropfind(byPath: Record<string, { href: string; dir: boolean }[]>) {
  routes = byPath;
}

const BASE = `https://cp.example/workspaces/ws-1/webapp/7445${FILES_DAV_ROOT}/`;

function workspaceClient() {
  return createClient(BASE, { withCredentials: true, remoteBasePath: FILES_DAV_ROOT });
}

describe('workspace DAV listings through the proxy', () => {
  it('drops the self entry every PROPFIND includes, at the root and in subdirectories', async () => {
    stubPropfind({
      '/workspaces/ws-1/webapp/7445/workspace': [
        { href: '/workspace/', dir: true },
        { href: '/workspace/shared/', dir: true },
      ],
      '/workspaces/ws-1/webapp/7445/workspace/shared': [
        { href: '/workspace/shared/', dir: true },
        { href: '/workspace/shared/test/', dir: true },
        { href: '/workspace/shared/readme.md', dir: false },
      ],
      '/workspaces/ws-1/webapp/7445/workspace/shared/test': [
        { href: '/workspace/shared/test/', dir: true },
      ],
    });
    const client = workspaceClient();

    const root = await client.getDirectoryContents('/') as FileStat[];
    expect(root.map(({ basename }) => basename)).toEqual(['shared']);
    expect(listedNodes('', root).map(({ path }) => path)).toEqual(['shared']);

    const shared = await client.getDirectoryContents('shared') as FileStat[];
    expect(shared.map(({ basename }) => basename).sort()).toEqual(['readme.md', 'test']);
    // Finder-style listing interleaves files and directories by name.
    expect(listedNodes('shared', shared).map(({ path }) => path))
      .toEqual(['shared/readme.md', 'shared/test']);

    const empty = await client.getDirectoryContents('shared/test') as FileStat[];
    expect(empty).toEqual([]);
  });

  it('keeps a child directory that shares its parent directory name', async () => {
    stubPropfind({
      '/workspaces/ws-1/webapp/7445/workspace/test': [
        { href: '/workspace/test/', dir: true },
        { href: '/workspace/test/test/', dir: true },
      ],
    });
    const listing = await workspaceClient().getDirectoryContents('test') as FileStat[];
    expect(listedNodes('test', listing).map(({ path }) => path)).toEqual(['test/test']);
  });
});
