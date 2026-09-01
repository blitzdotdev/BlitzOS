// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionMeta } from '@lody/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileTreeView } from '../src/components/sessions/components/file-tree-view';
import {
  buildFileTreeFromSessionFileProviderEntries,
  useSessionFileProviderTree,
} from '../src/hooks/use-code-session';
import { createSessionFileProviderFromSource } from '../src/lib/session-file-provider-selection';
import type { SessionFileProvider } from '../src/lib/session-file-provider';

vi.mock('../src/hooks/use-code-collab-requested-role', () => ({
  useCodeCollabRequestedRole: () => 'read',
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root && container) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
});

async function render(node: ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe('buildFileTreeFromSessionFileProviderEntries', () => {
  it('maps provider entries into the shared file tree shape', () => {
    expect(
      buildFileTreeFromSessionFileProviderEntries([
        {
          path: 'src/index.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
        {
          path: 'src/components/app.tsx',
          kind: 'text',
          sourceState: 'live-collaborative',
          modifiedTime: 1234,
        },
        {
          path: 'assets/logo.png',
          kind: 'binary',
          sourceState: 'live-collaborative',
        },
      ])
    ).toEqual([
      {
        path: 'assets',
        type: 'directory',
        modified: false,
        children: [{ path: 'assets/logo.png', type: 'file', modified: false }],
      },
      {
        path: 'src',
        type: 'directory',
        modified: true,
        children: [
          {
            path: 'src/components',
            type: 'directory',
            modified: true,
            children: [{ path: 'src/components/app.tsx', type: 'file', modified: true }],
          },
          { path: 'src/index.ts', type: 'file', modified: false },
        ],
      },
    ]);
  });

  it('marks the provider tree load as ready once listFiles returns', async () => {
    const provider = createSessionFileProviderFromSource({
      kind: 'none',
      message: 'Files are unavailable',
    });
    const rendered = await render(createElement(ProviderTreeProbe, { provider }));

    expect(rendered.textContent).toContain('ready:true');
    expect(rendered.textContent).toContain('synced:false');
    expect(rendered.textContent).toContain('Files are unavailable');
  });

  it('treats an empty Code Collab file list as a normal empty directory', async () => {
    const provider = {
      kind: 'code-collab',
      getState: () => ({
        kind: 'code-collab',
        ready: true,
        sourceState: 'live-collaborative',
      }),
      listFiles: vi.fn(async () => []),
    } as unknown as SessionFileProvider;
    const rendered = await render(createElement(ProviderTreeProbe, { provider }));

    expect(rendered.textContent).toContain('ready:true');
    expect(rendered.textContent).toContain('synced:true');
    expect(rendered.textContent).toContain('roots:0');
    expect(rendered.textContent).not.toContain('host has not published');
  });

  it('renders a plain empty-directory message for empty provider file trees', async () => {
    const provider = createReadyProvider([]);
    const session = {
      id: 'session-provider-tree-empty',
      machineId: 'machine-1',
      createdAt: '2026-05-14T00:00:00.000Z',
      userId: 'user-1',
      cliType: 'codex',
      agentType: 'codex',
    } as unknown as SessionMeta;

    const rendered = await render(
      createElement(FileTreeView, {
        session,
        handleOpenFile: () => undefined,
        fileProvider: provider,
        fileProviderPending: false,
      })
    );

    expect(rendered.textContent).toContain('This directory is empty.');
    expect(rendered.textContent).not.toContain('host has not published');
  });

  it('renders provider files without waiting for another file source', async () => {
    const provider = createReadyProvider([
      {
        path: 'src/index.ts',
        kind: 'text',
        sourceState: 'live-readonly',
      },
    ]);
    const session = {
      id: 'session-provider-tree-render',
      machineId: 'machine-1',
      createdAt: '2026-05-14T00:00:00.000Z',
      userId: 'user-1',
      cliType: 'codex',
      agentType: 'codex',
    } as unknown as SessionMeta;

    const rendered = await render(
      createElement(FileTreeView, {
        session,
        handleOpenFile: () => undefined,
        fileProvider: provider,
        fileProviderPending: false,
      })
    );

    expect(rendered.textContent).toContain('src');
    expect(rendered.textContent).not.toContain('Connecting to code session');
  });
});

function createReadyProvider(
  files: Awaited<ReturnType<SessionFileProvider['listFiles']>>
): SessionFileProvider {
  return {
    kind: 'code-collab',
    getState: () => ({
      kind: 'code-collab',
      ready: true,
      sourceState: 'live-readonly',
    }),
    listFiles: vi.fn(async () => files),
  } as unknown as SessionFileProvider;
}

function ProviderTreeProbe({ provider }: { readonly provider: SessionFileProvider }) {
  const tree = useSessionFileProviderTree(provider);
  return createElement(
    'div',
    null,
    `ready:${String(tree.ready)} synced:${String(tree.synced)} roots:${tree.state.length} message:${
      tree.message ?? ''
    }`
  );
}
