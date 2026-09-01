import { describe, expect, it, vi } from 'vitest';
import {
  connectionsFocusEndpointUrl,
  fetchWorkspaceConnectionsFocus,
  parseConnectionsFocus,
} from '../src/connections-focus.js';
import type { JsonValue } from '../src/type-guards.js';

type FocusFixture = {
  input: JsonValue;
  expected: { focus: JsonValue };
};

const focusFixtures = import.meta.glob<FocusFixture>(
  '../../schema/fixtures/connections-focus/*.json',
  { eager: true, import: 'default' },
);

describe('connections-focus browser consumer contract', () => {
  it('pins the shared connections-focus fixture corpus', () => {
    expect(Object.keys(focusFixtures).map((path) => path.split('/').at(-1)).sort()).toEqual([
      'absent.json',
      'bad-provider-uppercase.json',
      'empty-provider.json',
      'long-provider-64.json',
      'long-provider.json',
      'negative-requested-at.json',
      'valid-generic-name.json',
      'valid-github.json',
      'valid-provider-63.json',
      'wrong-version.json',
    ]);
  });

  it('accepts every marker the gateway keeps and rejects every one it drops', () => {
    for (const [path, fixture] of Object.entries(focusFixtures)) {
      // The canonical gateway response body parses to exactly its focus.
      expect(parseConnectionsFocus(fixture.expected), path).toEqual(fixture.expected.focus);
      // Defense in depth: even if a box handed back the raw marker as the
      // focus, the browser's own guards reach the same verdict — bad provider
      // names still collapse to null; the valid markers still pass; an absent
      // marker stays null.
      expect(parseConnectionsFocus({ focus: fixture.input }), path).toEqual(fixture.expected.focus);
    }
  });

  it('applies the provider charset rule at both edges', () => {
    const marker = (provider: string) => ({
      focus: { version: 1, provider, requestedAt: 1 },
    });
    // 63 is the grant validator's cap, exported as `isProviderName`.
    expect(parseConnectionsFocus(marker('a'.repeat(63)))?.provider).toBe('a'.repeat(63));
    expect(parseConnectionsFocus(marker('a'.repeat(64)))).toBeNull();
    expect(parseConnectionsFocus(marker('-leading'))).toBeNull();
    expect(parseConnectionsFocus(marker('has space'))).toBeNull();
    expect(parseConnectionsFocus(marker('google-workspace'))?.provider).toBe('google-workspace');
  });

  it('drops malformed focus shapes the fixtures do not cover', () => {
    expect(parseConnectionsFocus(null)).toBeNull();
    expect(parseConnectionsFocus({})).toBeNull();
    expect(parseConnectionsFocus({ focus: {} })).toBeNull();
    // Wrong version.
    expect(parseConnectionsFocus({
      focus: { version: 2, provider: 'github', requestedAt: 1 },
    })).toBeNull();
    // Non-integer / out-of-range requestedAt.
    expect(parseConnectionsFocus({
      focus: { version: 1, provider: 'github', requestedAt: -1 },
    })).toBeNull();
    expect(parseConnectionsFocus({
      focus: { version: 1, provider: 'github', requestedAt: 1.5 },
    })).toBeNull();
  });

  it('fetches the gateway focus and maps every failure mode to null', async () => {
    const base = 'https://box.example/workspace/';
    expect(connectionsFocusEndpointUrl(base)).toBe('https://box.example/connections-focus');
    const cpBase = 'https://cp.example/workspaces/one/webapp/7445/workspace/';
    expect(connectionsFocusEndpointUrl(cpBase)).toBe(
      'https://cp.example/workspaces/one/webapp/7445/connections-focus',
    );

    const okFetcher = vi.fn(async () => new Response(JSON.stringify({
      focus: { version: 1, provider: 'github', requestedAt: 1787000000000 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(fetchWorkspaceConnectionsFocus(base, okFetcher)).resolves.toEqual({
      ok: true,
      focus: { version: 1, provider: 'github', requestedAt: 1787000000000 },
    });
    expect(okFetcher).toHaveBeenCalledWith('https://box.example/connections-focus', {
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
    await expect(fetchWorkspaceConnectionsFocus(base, notFound)).resolves.toEqual({ ok: false });

    // Empty 200 body — unparseable, so also a failed read.
    const empty = vi.fn(async () => new Response('', { status: 200 }));
    await expect(fetchWorkspaceConnectionsFocus(base, empty)).resolves.toEqual({ ok: false });

    // Network errors are swallowed, still as a failed read.
    const throws = vi.fn(async () => { throw new Error('offline'); });
    await expect(fetchWorkspaceConnectionsFocus(base, throws)).resolves.toEqual({ ok: false });

    // A successful read with nothing focused is a real answer.
    const nullFocus = vi.fn(async () => new Response(JSON.stringify({ focus: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(fetchWorkspaceConnectionsFocus(base, nullFocus))
      .resolves.toEqual({ ok: true, focus: null });

    // So is a successful read the client's own guards reject: a provider name
    // no row could carry means the box has nothing this browser may select.
    const badName = vi.fn(async () => new Response(JSON.stringify({
      focus: { version: 1, provider: 'Not A Provider', requestedAt: 1787000002000 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(fetchWorkspaceConnectionsFocus(base, badName))
      .resolves.toEqual({ ok: true, focus: null });
  });
});
