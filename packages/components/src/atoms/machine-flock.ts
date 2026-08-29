import { atom } from 'jotai';
import {
  applyMachineFlockRowEvents,
  type MachineFlockEvent,
  type MachineFlockRowMap,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';

type MachineFlockRowsByWorkspace = Record<string, Record<string, MachineFlockRowMap>>;

const EMPTY_MACHINE_FLOCK_ROWS = Object.freeze({}) as MachineFlockRowMap;

export const machineFlockRowsByWorkspaceAtom = atom<MachineFlockRowsByWorkspace>({});

function machineFlockRowsEmpty(rows: MachineFlockRowMap): boolean {
  return Object.keys(rows).length === 0;
}

export const setMachineFlockRowsForMachineAtom = atom(
  null,
  (
    _get,
    set,
    update: {
      workspaceId: WorkspaceId | string;
      machineId: MachineId | string;
      rows: MachineFlockRowMap;
      mode?: 'replace' | 'merge';
      preserveExistingOnEmpty?: boolean;
    }
  ) => {
    set(machineFlockRowsByWorkspaceAtom, (previous) => {
      const workspaceKey = String(update.workspaceId);
      const machineKey = String(update.machineId);
      const workspaceRows = previous[workspaceKey] ?? {};
      const currentRows = workspaceRows[machineKey];
      const nextRows =
        update.mode === 'merge' && currentRows ? { ...currentRows, ...update.rows } : update.rows;
      if (
        update.preserveExistingOnEmpty &&
        machineFlockRowsEmpty(update.rows) &&
        currentRows &&
        !machineFlockRowsEmpty(currentRows)
      ) {
        return previous;
      }
      // Hook bootstrap and explicit resync snapshots are guarded by the Flock
      // version before they reach the atom. Incremental event application
      // returns the previous map by identity when it is a no-op, so a whole-map
      // deep comparison here only repeats expensive renderer-main-thread work.
      if (currentRows === nextRows) {
        return previous;
      }
      return {
        ...previous,
        [workspaceKey]: {
          ...workspaceRows,
          [machineKey]: nextRows,
        },
      };
    });
  }
);

export const applyMachineFlockRowEventsForMachineAtom = atom(
  null,
  (
    get,
    set,
    update: {
      workspaceId: WorkspaceId | string;
      machineId: MachineId | string;
      events: readonly MachineFlockEvent[];
    }
  ) => {
    const workspaceKey = String(update.workspaceId);
    const machineKey = String(update.machineId);
    const workspaceRows = get(machineFlockRowsByWorkspaceAtom)[workspaceKey] ?? {};
    const currentRows = workspaceRows[machineKey] ?? EMPTY_MACHINE_FLOCK_ROWS;
    const nextRows = applyMachineFlockRowEvents(currentRows, update.events);
    set(setMachineFlockRowsForMachineAtom, {
      workspaceId: workspaceKey,
      machineId: machineKey,
      rows: nextRows,
    });
  }
);
