import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { currentWorkspaceIdAtom } from './workspace-context';

export type MachineSettingsFilter = {
  onlineOnly: boolean;
  mineOnly: boolean;
};

const DEFAULT_FILTER: MachineSettingsFilter = {
  onlineOnly: false,
  mineOnly: false,
};

const machineFilterByWorkspaceAtom = atomWithStorage<Record<string, MachineSettingsFilter>>(
  'lody-settings-machine-filter-by-workspace',
  {}
);

/**
 * Machine tab filter (online-only, mine-only), per workspace.
 * The selected machine itself lives in the URL as `?machine=<id>`; see
 * `/$workspaceName/_auth/settings/agent-config` route.
 */
export const machineSettingsFilterAtom = atom<MachineSettingsFilter, [MachineSettingsFilter], void>(
  (get) => {
    const workspaceId = get(currentWorkspaceIdAtom);
    if (!workspaceId) return DEFAULT_FILTER;
    return get(machineFilterByWorkspaceAtom)[workspaceId] ?? DEFAULT_FILTER;
  },
  (get, set, next) => {
    const workspaceId = get(currentWorkspaceIdAtom);
    if (!workspaceId) return;
    const map = get(machineFilterByWorkspaceAtom);
    set(machineFilterByWorkspaceAtom, { ...map, [workspaceId]: next });
  }
);
