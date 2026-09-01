import { describe, expect, it } from 'vitest';
import {
  SessionStatusFactory,
  getLodyMachinePresenceKey,
  getLodySessionPresenceKey,
  type LodyPresenceInstanceId,
  type LodyPresenceStateMap,
  type MachineId,
  type SessionId,
} from '@lody/shared';

import { mergePresenceSnapshots } from '../src/providers/presence-snapshot-merge';

const LOCAL_INSTANCE = 'local-instance' as LodyPresenceInstanceId;
const REMOTE_INSTANCE = 'remote-instance' as LodyPresenceInstanceId;
const LOCAL_MACHINE = 'local-machine' as MachineId;
const REMOTE_MACHINE = 'remote-machine' as MachineId;
const SESSION = 'session-1' as SessionId;

describe('mergePresenceSnapshots', () => {
  it('does not resurrect locally-cleared session presence from a stale cloud replica', () => {
    const localMachineKey = getLodyMachinePresenceKey(LOCAL_MACHINE, LOCAL_INSTANCE);
    const localSessionKey = getLodySessionPresenceKey(SESSION, LOCAL_INSTANCE);
    const localStates: LodyPresenceStateMap = {
      [localMachineKey]: {
        kind: 'machine',
        machineId: LOCAL_MACHINE,
        instanceId: LOCAL_INSTANCE,
        updatedAt: 200,
      },
    };
    const cloudStates: LodyPresenceStateMap = {
      [localMachineKey]: {
        kind: 'machine',
        machineId: LOCAL_MACHINE,
        instanceId: LOCAL_INSTANCE,
        updatedAt: 100,
      },
      [localSessionKey]: {
        kind: 'session',
        sessionId: SESSION,
        machineId: LOCAL_MACHINE,
        instanceId: LOCAL_INSTANCE,
        status: SessionStatusFactory.initializing(),
        updatedAt: 100,
      },
    };

    expect(mergePresenceSnapshots(localStates, cloudStates)).toEqual(localStates);
  });

  it('preserves cloud presence from remote CLI instances', () => {
    // The scenario the origin split exists for: a turn running on ANOTHER
    // machine. Its presence reaches the cloud replica on every phase change,
    // while the local plane only speaks for the local CLI — so if the local
    // snapshot ever claimed authority over the remote instance, that session
    // would go statusless between local writes.
    const localMachineKey = getLodyMachinePresenceKey(LOCAL_MACHINE, LOCAL_INSTANCE);
    const remoteMachineKey = getLodyMachinePresenceKey(REMOTE_MACHINE, REMOTE_INSTANCE);
    const remoteSessionKey = getLodySessionPresenceKey(SESSION, REMOTE_INSTANCE);
    const localOriginStates: LodyPresenceStateMap = {
      [localMachineKey]: {
        kind: 'machine',
        machineId: LOCAL_MACHINE,
        instanceId: LOCAL_INSTANCE,
        updatedAt: 200,
      },
    };
    const cloudStates: LodyPresenceStateMap = {
      [remoteMachineKey]: {
        kind: 'machine',
        machineId: REMOTE_MACHINE,
        instanceId: REMOTE_INSTANCE,
        updatedAt: 100,
      },
      [remoteSessionKey]: {
        kind: 'session',
        sessionId: SESSION,
        machineId: REMOTE_MACHINE,
        instanceId: REMOTE_INSTANCE,
        status: SessionStatusFactory.initializing(),
        updatedAt: 100,
      },
    };

    expect(mergePresenceSnapshots(localOriginStates, cloudStates)).toEqual({
      ...cloudStates,
      ...localOriginStates,
    });
  });
});
