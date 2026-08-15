import { describe, expect, it, vi } from 'vitest';
import {
  fetchWorkspacePorts,
  portsEndpointUrl,
  previewUrl,
} from '../src/preview.js';

describe('box preview contract', () => {
  it('uses the files origin for discovery and preview paths', async () => {
    expect(portsEndpointUrl('http://localhost:7445/workspace/')).toBe('http://localhost:7445/ports');
    expect(previewUrl('http://localhost:7445/workspace/', 3000)).toBe(
      'http://localhost:7445/preview/3000/',
    );
    expect(previewUrl('wss://box.example/workspace/', 5173, '/docs/start', '?mode=dark')).toBe(
      'https://box.example/preview/5173/docs/start?mode=dark',
    );
    const cpFiles = 'https://cp.example/workspaces/one/surface/7445/workspace/';
    expect(portsEndpointUrl(cpFiles)).toBe(
      'https://cp.example/workspaces/one/surface/7445/ports',
    );
    expect(previewUrl(cpFiles, 3000, '/docs', '?mode=dark')).toBe(
      'https://cp.example/workspaces/one/surface/7445/preview/3000/docs?mode=dark',
    );

    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ports: [{ port: 3000, process: 'node' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(fetchWorkspacePorts('https://box.example/workspace/', fetcher)).resolves.toEqual([
      { port: 3000, process: 'node' },
    ]);
    expect(fetcher).toHaveBeenCalledWith('https://box.example/ports', {
      credentials: 'include',
      signal: undefined,
    });
  });
});
