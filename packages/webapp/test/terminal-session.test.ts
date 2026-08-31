import { describe, expect, it, vi } from 'vitest';
import {
  endTerminalSessionUrl,
  endWorkspaceTerminalSession,
  isEndableSessionKind,
} from '../src/terminal-session';

interface EndFixture {
  request: { kind: string; key: string };
  status: number;
  target?: string;
}

const fixtures = import.meta.glob<EndFixture>(
  '../../schema/fixtures/terminal-session-end/*.json',
  { eager: true, import: 'default' },
);

function named(): Array<[string, EndFixture]> {
  return Object.entries(fixtures)
    .map(([path, fixture]): [string, EndFixture] => [path.slice(path.lastIndexOf('/') + 1), fixture])
    .sort(([left], [right]) => left.localeCompare(right));
}

const FILES_BASE = 'https://cp.example/workspaces/ws-1/webapp/7445/workspace/';

describe('end terminal session (browser)', () => {
  it('posts every accepted fixture to the gateway with its exact kind and key', async () => {
    let posted = 0;
    for (const [name, fixture] of named()) {
      if (fixture.status !== 200) continue;
      posted += 1;
      expect(isEndableSessionKind(fixture.request.kind), name).toBe(true);
      const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ended: true }));
      const result = await endWorkspaceTerminalSession(
        FILES_BASE,
        fixture.request.kind as 'terminal' | 'claude' | 'codex',
        fixture.request.key,
        fetcher,
      );
      expect(result, name).toEqual({ ok: true, ended: true });
      expect(String(fetcher.mock.calls[0]?.[0]), name)
        .toBe('https://cp.example/workspaces/ws-1/webapp/7445/terminal/session/end');
      const init = fetcher.mock.calls[0]?.[1];
      expect(init?.method, name).toBe('POST');
      expect(JSON.parse(String(init?.body)), name).toEqual(fixture.request);
    }
    expect(posted).toBeGreaterThanOrEqual(3);
  });

  it('never treats a non-tmux kind as endable', () => {
    for (const [name, fixture] of named()) {
      const endable = isEndableSessionKind(fixture.request.kind);
      if (['chat', 'opencode'].includes(fixture.request.kind)) {
        expect(endable, name).toBe(false);
      } else {
        expect(endable, name).toBe(true);
      }
    }
  });

  it('reports ok:false for an old box that 404s the route, and passes ended through', async () => {
    const missing = await endWorkspaceTerminalSession(FILES_BASE, 'claude', 'k',
      vi.fn(async () => new Response(null, { status: 404 })));
    expect(missing).toEqual({ ok: false });
    const absent = await endWorkspaceTerminalSession(FILES_BASE, 'claude', 'gone',
      vi.fn(async () => Response.json({ ended: false })));
    expect(absent).toEqual({ ok: true, ended: false });
    const failed = await endWorkspaceTerminalSession(FILES_BASE, 'claude', 'k',
      vi.fn(async () => { throw new Error('offline'); }));
    expect(failed).toEqual({ ok: false });
  });

  it('derives the endpoint beside the files base', () => {
    expect(endTerminalSessionUrl(FILES_BASE))
      .toBe('https://cp.example/workspaces/ws-1/webapp/7445/terminal/session/end');
  });
});
