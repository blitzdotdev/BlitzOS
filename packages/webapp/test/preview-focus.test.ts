import { describe, expect, it, vi } from 'vitest';
import {
  fetchWorkspacePreviewFocus,
  isPreviewPath,
  isPreviewPort,
  parsePreviewFocus,
  previewFocusEndpointUrl,
} from '../src/preview.js';
import type { JsonValue } from '../src/type-guards.js';

type FocusFixture = {
  input: JsonValue;
  expected: { focus: JsonValue };
};

type ReservedPorts = {
  minPort: number;
  maxPort: number;
  maxPathLength: number;
  reservedPorts: number[];
};

const focusFixtures = import.meta.glob<FocusFixture>(
  '../../schema/fixtures/preview-focus/*.json',
  { eager: true, import: 'default' },
);

const reservedPortFixtures = import.meta.glob<ReservedPorts>(
  '../../schema/fixtures/preview-ports/reserved.json',
  { eager: true, import: 'default' },
);

function reservedPorts(): ReservedPorts {
  const [fixture] = Object.values(reservedPortFixtures);
  if (fixture === undefined) throw new Error('reserved-ports fixture was not inlined');
  return fixture;
}

describe('preview-focus browser consumer contract', () => {
  it('pins the shared preview-focus fixture corpus', () => {
    expect(Object.keys(focusFixtures).map((path) => path.split('/').at(-1)).sort()).toEqual([
      'absent.json',
      'bad-kind.json',
      'bad-path.json',
      'file-outside-workspace.json',
      'file-traversal.json',
      'reserved-port-17445.json',
      'reserved-port-7446.json',
      'reserved-port.json',
      'traversal-path.json',
      'url-not-https.json',
      'valid-defaults.json',
      'valid-file.json',
      'valid-url.json',
      'valid-v1-legacy.json',
      'valid-with-path.json',
    ]);
  });

  it('reserves exactly the ports the shared fixture names', () => {
    const { minPort, maxPort, reservedPorts: reserved } = reservedPorts();
    for (const port of reserved) {
      expect(isPreviewPort(port), `reserved ${String(port)}`).toBe(false);
    }
    expect(isPreviewPort(minPort)).toBe(true);
    expect(isPreviewPort(maxPort)).toBe(true);
    expect(isPreviewPort(minPort - 1)).toBe(false);
    expect(isPreviewPort(maxPort + 1)).toBe(false);
    // Every other port in the box's own block is usable, so the set is a hole
    // in the range rather than a wider exclusion.
    for (const port of [7442, 7447, 17444, 17446]) {
      expect(isPreviewPort(port), String(port)).toBe(true);
    }
  });

  it('drops a traversal or over-long deep-link path', () => {
    const { maxPathLength } = reservedPorts();
    expect(isPreviewPath('/dashboard')).toBe(true);
    expect(isPreviewPath('/a..b')).toBe(true);
    expect(isPreviewPath(`/${'a'.repeat(maxPathLength - 1)}`)).toBe(true);
    expect(isPreviewPath('dashboard')).toBe(false);
    expect(isPreviewPath('/..')).toBe(false);
    expect(isPreviewPath('/app/../../workspace/')).toBe(false);
    expect(isPreviewPath(`/${'a'.repeat(maxPathLength)}`)).toBe(false);
    // And through the parser the poller actually calls.
    const marker = (path: string) => ({
      focus: { version: 1, port: 3000, path, title: 't', requestedAt: 1 },
    });
    expect(parsePreviewFocus(marker('/app/../../workspace/'))).toBeNull();
    expect(parsePreviewFocus(marker(`/${'a'.repeat(maxPathLength)}`))).toBeNull();
    const parsed = parsePreviewFocus(marker('/dashboard'));
    expect(parsed?.kind === 'port' ? parsed.path : null).toBe('/dashboard');
  });

  /** The browser's own reading of a served marker: a version-1 marker is a
   * port, a version-2 marker names its kind, and the wire's `version` is not
   * something the shell acts on. */
  function targetOf(focus: JsonValue): Record<string, JsonValue | undefined> | null {
    if (focus === null || typeof focus !== 'object' || Array.isArray(focus)) return null;
    const { version, kind, ...rest } = focus;
    return { kind: version === 1 ? 'port' : kind, ...rest };
  }

  it('accepts every marker the gateway keeps and rejects every one it drops', () => {
    for (const [path, fixture] of Object.entries(focusFixtures)) {
      // The canonical gateway response body parses to exactly its focus.
      expect(parsePreviewFocus(fixture.expected), path).toEqual(targetOf(fixture.expected.focus));
      // Defense in depth: even if a box handed back the raw marker as the focus,
      // the browser's own guards reach the same verdict — reserved ports
      // (reserved-port.json) and unrooted paths (bad-path.json) still collapse
      // to null; the valid markers still pass; an absent marker stays null.
      expect(parsePreviewFocus({ focus: fixture.input }), path).toEqual(targetOf(fixture.expected.focus));
    }
  });

  it('drops malformed focus shapes the fixtures do not cover', () => {
    expect(parsePreviewFocus(null)).toBeNull();
    expect(parsePreviewFocus({})).toBeNull();
    expect(parsePreviewFocus({ focus: {} })).toBeNull();
    // Wrong version, and a version 2 that names no kind.
    expect(parsePreviewFocus({
      focus: { version: 3, kind: 'port', port: 3000, path: '/', title: 't', requestedAt: 1 },
    })).toBeNull();
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
      ok: true,
      focus: {
        kind: 'port',
        port: 5173,
        path: '/dashboard',
        title: 'Docs',
        requestedAt: 1787000001000,
      },
    });
    expect(okFetcher).toHaveBeenCalledWith('https://box.example/preview-focus', {
      credentials: 'include',
      // BUG-CV-01: every read of the box gateway carries a deadline now, so a
      // tunnel with no connections cannot hold this socket for the life of the
      // tab. The signal is composed here rather than passed in, which is why a
      // caller that supplied none still gets one.
      signal: expect.any(AbortSignal),
    });

    // A read that never reached the box is reported as a failure, not as
    // "the box has no focus": the caller must not adopt it as a baseline.
    // Old boxes 404 the route.
    const notFound = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(fetchWorkspacePreviewFocus(base, notFound)).resolves.toEqual({ ok: false });

    // Empty 200 body — unparseable, so also a failed read.
    const empty = vi.fn(async () => new Response('', { status: 200 }));
    await expect(fetchWorkspacePreviewFocus(base, empty)).resolves.toEqual({ ok: false });

    // Network errors are swallowed, still as a failed read.
    const throws = vi.fn(async () => { throw new Error('offline'); });
    await expect(fetchWorkspacePreviewFocus(base, throws)).resolves.toEqual({ ok: false });

    // A successful read with nothing focused is a real answer.
    const nullFocus = vi.fn(async () => new Response(JSON.stringify({ focus: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(fetchWorkspacePreviewFocus(base, nullFocus))
      .resolves.toEqual({ ok: true, focus: null });

    // So is a successful read the client's own guards reject: a reserved port
    // on a 200 means the box has nothing this browser may open.
    const reserved = vi.fn(async () => new Response(JSON.stringify({
      focus: { version: 1, port: 7445, path: '/', title: 'gateway', requestedAt: 1787000002000 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(fetchWorkspacePreviewFocus(base, reserved))
      .resolves.toEqual({ ok: true, focus: null });
  });
});
