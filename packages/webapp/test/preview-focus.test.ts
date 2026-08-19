import { describe, expect, it, vi } from 'vitest';
import {
  fetchWorkspacePreviewFocus,
  parsePreviewFocus,
  previewFocusEndpointUrl,
} from '../src/preview.js';
import type { JsonValue } from '../src/type-guards.js';

type FocusFixture = {
  input: JsonValue;
  expected: { focus: JsonValue };
};

const focusFixtures = import.meta.glob<FocusFixture>(
  '../../schema/fixtures/preview-focus/*.json',
  { eager: true, import: 'default' },
);

describe('preview-focus browser consumer contract', () => {
  it('pins the shared preview-focus fixture corpus', () => {
    expect(Object.keys(focusFixtures).map((path) => path.split('/').at(-1)).sort()).toEqual([
      'absent.json',
      'bad-path.json',
      'reserved-port.json',
      'valid-defaults.json',
      'valid-with-path.json',
    ]);
  });

  it('accepts every marker the gateway keeps and rejects every one it drops', () => {
    for (const [path, fixture] of Object.entries(focusFixtures)) {
      // The canonical gateway response body parses to exactly its focus.
      expect(parsePreviewFocus(fixture.expected), path).toEqual(fixture.expected.focus);
      // Defense in depth: even if a box handed back the raw marker as the focus,
      // the browser's own guards reach the same verdict — reserved ports
      // (reserved-port.json) and unrooted paths (bad-path.json) still collapse
      // to null; the valid markers still pass; an absent marker stays null.
      expect(parsePreviewFocus({ focus: fixture.input }), path).toEqual(fixture.expected.focus);
    }
  });

  it('drops malformed focus shapes the fixtures do not cover', () => {
    expect(parsePreviewFocus(null)).toBeNull();
    expect(parsePreviewFocus({})).toBeNull();
    expect(parsePreviewFocus({ focus: {} })).toBeNull();
    // Wrong version.
    expect(parsePreviewFocus({
      focus: { version: 2, port: 3000, path: '/', title: 't', requestedAt: 1 },
    })).toBeNull();
    // Non-integer / out-of-range requestedAt.
    expect(parsePreviewFocus({
      focus: { version: 1, port: 3000, path: '/', title: 't', requestedAt: -1 },
    })).toBeNull();
    expect(parsePreviewFocus({
      focus: { version: 1, port: 3000, path: '/', title: 't', requestedAt: 1.5 },
    })).toBeNull();
  });

  it('fetches the gateway focus and maps every failure mode to null', async () => {
    const base = 'https://box.example/workspace/';
    expect(previewFocusEndpointUrl(base)).toBe('https://box.example/preview-focus');
    const cpBase = 'https://cp.example/workspaces/one/webapp/7445/workspace/';
    expect(previewFocusEndpointUrl(cpBase)).toBe(
      'https://cp.example/workspaces/one/webapp/7445/preview-focus',
    );

    const okFetcher = vi.fn(async () => new Response(JSON.stringify({
      focus: { version: 1, port: 5173, path: '/dashboard', title: 'Docs', requestedAt: 1787000001000 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(fetchWorkspacePreviewFocus(base, okFetcher)).resolves.toEqual({
      version: 1,
      port: 5173,
      path: '/dashboard',
      title: 'Docs',
      requestedAt: 1787000001000,
    });
    expect(okFetcher).toHaveBeenCalledWith('https://box.example/preview-focus', {
      credentials: 'include',
      signal: undefined,
    });

    // Old boxes 404 the route.
    const notFound = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(fetchWorkspacePreviewFocus(base, notFound)).resolves.toBeNull();

    // No active focus.
    const nullFocus = vi.fn(async () => new Response(JSON.stringify({ focus: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(fetchWorkspacePreviewFocus(base, nullFocus)).resolves.toBeNull();

    // Empty 200 body.
    const empty = vi.fn(async () => new Response('', { status: 200 }));
    await expect(fetchWorkspacePreviewFocus(base, empty)).resolves.toBeNull();

    // A reserved port the client rejects even on a 200.
    const reserved = vi.fn(async () => new Response(JSON.stringify({
      focus: { version: 1, port: 7445, path: '/', title: 'gateway', requestedAt: 1787000002000 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(fetchWorkspacePreviewFocus(base, reserved)).resolves.toBeNull();

    // Network errors are swallowed.
    const throws = vi.fn(async () => { throw new Error('offline'); });
    await expect(fetchWorkspacePreviewFocus(base, throws)).resolves.toBeNull();
  });
});
