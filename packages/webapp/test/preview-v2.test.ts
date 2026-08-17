import { describe, expect, it, vi } from 'vitest';
import {
  fetchWorkspacePreviews,
  fetchWorkspacePorts,
  isEmbeddablePreviewUrl,
  parsedPreviews,
  portsEndpointUrl,
  previewsEndpointUrl,
  previewUrl,
  type PreviewLink,
} from '../src/preview.js';
import type { JsonValue } from '../src/type-guards.js';

type PreviewFixture = {
  input: JsonValue;
  expected: { previews: PreviewLink[] };
};

const previewFixtures = import.meta.glob<PreviewFixture>(
  '../../schema/fixtures/previews/*.json',
  { eager: true, import: 'default' },
);

describe('box preview contract', () => {
  it('uses the files origin for discovery and preview paths', async () => {
    expect(portsEndpointUrl('http://localhost:7445/workspace/')).toBe('http://localhost:7445/ports');
    expect(previewsEndpointUrl('http://localhost:7445/workspace/')).toBe(
      'http://localhost:7445/previews',
    );
    expect(previewUrl('http://localhost:7445/workspace/', 3000)).toBe(
      'http://localhost:7445/preview/3000/',
    );
    expect(previewUrl('wss://box.example/workspace/', 5173, '/docs/start', '?mode=dark')).toBe(
      'https://box.example/preview/5173/docs/start?mode=dark',
    );
    const cpFiles = 'https://cp.example/workspaces/one/webapp/7445/workspace/';
    expect(portsEndpointUrl(cpFiles)).toBe(
      'https://cp.example/workspaces/one/webapp/7445/ports',
    );
    expect(previewsEndpointUrl(cpFiles)).toBe(
      'https://cp.example/workspaces/one/webapp/7445/previews',
    );
    expect(previewUrl(cpFiles, 3000, '/docs', '?mode=dark')).toBe(
      'https://cp.example/workspaces/one/webapp/7445/preview/3000/docs?mode=dark',
    );

    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ports: [
        { port: 3000, process: 'node' },
        { port: 8080, process: 'cloudflared' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(fetchWorkspacePorts('https://box.example/workspace/', fetcher)).resolves.toEqual([
      { port: 3000, process: 'node' },
    ]);
    expect(fetcher).toHaveBeenCalledWith('https://box.example/ports', {
      credentials: 'include',
      signal: undefined,
    });

    const previewFetcher = vi.fn(async () => new Response(JSON.stringify({
      previews: [{
        url: 'https://demo.blitz.dev',
        title: 'Demo',
        source: 'agent',
        createdAt: 1786900000000,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(fetchWorkspacePreviews(
      'https://box.example/workspace/',
      previewFetcher,
    )).resolves.toEqual([{
      url: 'https://demo.blitz.dev',
      title: 'Demo',
      source: 'agent',
      createdAt: 1786900000000,
    }]);
    expect(previewFetcher).toHaveBeenCalledWith('https://box.example/previews', {
      credentials: 'include',
      signal: undefined,
    });
  });

  it('parses the shared public-preview fixtures', () => {
    expect(Object.keys(previewFixtures).map((path) => path.split('/').at(-1)).sort()).toEqual([
      'empty.json',
      'malformed-entry.json',
      'unknown-extra-fields.json',
      'valid-multi.json',
    ]);
    for (const [path, fixture] of Object.entries(previewFixtures)) {
      expect(parsedPreviews(fixture.input), path).toEqual(fixture.expected.previews);
    }
  });

  it('deduplicates public previews by exact URL', () => {
    expect(parsedPreviews({
      previews: [
        { url: 'https://demo.blitz.dev', title: 'First', source: 'agent', createdAt: 1 },
        { url: 'https://demo.blitz.dev', title: 'Second', source: 'agent', createdAt: 2 },
      ],
    })).toEqual([
      { url: 'https://demo.blitz.dev', title: 'First', source: 'agent', createdAt: 1 },
    ]);
  });

  it('only embeds HTTPS blitz.dev hosts', () => {
    expect(isEmbeddablePreviewUrl('https://blitz.dev')).toBe(true);
    expect(isEmbeddablePreviewUrl('https://sub.blitz.dev/path')).toBe(true);
    expect(isEmbeddablePreviewUrl('http://blitz.dev')).toBe(false);
    expect(isEmbeddablePreviewUrl('https://evil.com')).toBe(false);
    expect(isEmbeddablePreviewUrl('https://notblitz.dev')).toBe(false);
    expect(isEmbeddablePreviewUrl('https://blitz.dev.evil.com')).toBe(false);
  });
});
