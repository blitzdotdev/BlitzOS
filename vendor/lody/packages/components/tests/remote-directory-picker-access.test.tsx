// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { MachineId } from '@lody/shared';
import {
  RemoteDirectoryPicker,
  type RemoteDirectoryOps,
  type RemoteDirectoryPickerMachine,
} from '../src/components/local-projects/add-local-project-dialog';
import { initI18n } from '../src/i18n';

const ownMachineId = 'machine-own' as MachineId;
const teammateMachineId = 'machine-team' as MachineId;

const machines: RemoteDirectoryPickerMachine[] = [
  {
    id: ownMachineId,
    name: 'My Mac',
    online: true,
    ownerName: 'Zoe',
    canAddProjects: true,
  },
  {
    id: teammateMachineId,
    name: 'Build server',
    online: true,
    ownerName: 'Alex Chen',
    canAddProjects: false,
  },
];

function findMachineButton(name: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(name)
  );
  if (!button) throw new Error(`Expected machine button for ${name}`);
  return button;
}

function createOps() {
  const listRoots = vi.fn<RemoteDirectoryOps['listRoots']>(async () => ({
    ok: true,
    value: { platform: 'darwin', pathSeparator: '/', homeDir: '/Users/zoe' },
  }));
  const browseDir = vi.fn<RemoteDirectoryOps['browseDir']>(async () => ({
    ok: true,
    value: {
      path: '/Users/zoe',
      parentPath: null,
      entries: [],
      truncated: false,
    },
  }));
  const ops: RemoteDirectoryOps = {
    listRoots,
    browseDir,
    addProject: vi.fn(),
  };
  return { listRoots, browseDir, ops };
}

describe('RemoteDirectoryPicker machine ownership', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('explains teammate ownership without sending a browse request', async () => {
    const { listRoots, browseDir, ops } = createOps();

    await act(async () => {
      root?.render(
        <RemoteDirectoryPicker machines={machines} ops={ops} onAdded={vi.fn()} onClose={vi.fn()} />
      );
    });

    await act(async () => {
      findMachineButton('Build server').click();
    });

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'This machine belongs to Alex Chen'
    );
    expect(listRoots).not.toHaveBeenCalled();
    expect(browseDir).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Choose a machine');

    await act(async () => {
      findMachineButton('My Mac').click();
    });

    expect(listRoots).toHaveBeenCalledWith(ownMachineId);
    expect(browseDir).toHaveBeenCalledWith(ownMachineId, {
      absolutePath: '/Users/zoe',
    });
  });

  it('does not auto-browse a teammate machine supplied as the initial selection', async () => {
    const { listRoots, browseDir, ops } = createOps();

    await act(async () => {
      root?.render(
        <RemoteDirectoryPicker
          machines={machines}
          initialMachineId={teammateMachineId}
          ops={ops}
          onAdded={vi.fn()}
          onClose={vi.fn()}
        />
      );
    });

    expect(listRoots).not.toHaveBeenCalled();
    expect(browseDir).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Choose a machine');
  });

  it('shows a loading state while ownership identity is unresolved', async () => {
    const { ops } = createOps();

    await act(async () => {
      root?.render(
        <RemoteDirectoryPicker
          machines={[]}
          machinesLoading
          ops={ops}
          onAdded={vi.fn()}
          onClose={vi.fn()}
        />
      );
    });

    expect(document.body.textContent).toContain('Loading machines');
    expect(document.body.textContent).not.toContain('No machines available');
  });
});
