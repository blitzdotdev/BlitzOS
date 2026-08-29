import { describe, expect, it, vi } from 'vitest';
import type { MachineId } from '@lody/shared';
import {
  TargetRoutedMachineMonitor,
  type MachineMonitorTransportPort,
} from '../src/providers/target-routed-machine-monitor';

const LOCAL = 'machine-local' as MachineId;
const REMOTE = 'machine-remote' as MachineId;

const makePort = () => {
  const unsubscribe = vi.fn();
  const subscribeMachine = vi.fn(() => unsubscribe);
  const forceSample = vi.fn();
  return {
    port: { subscribeMachine, forceSample } satisfies MachineMonitorTransportPort,
    subscribeMachine,
    forceSample,
    unsubscribe,
  };
};

describe('TargetRoutedMachineMonitor', () => {
  it('keeps ownership pending, then routes local and remote targets independently', () => {
    const cloud = makePort();
    const local = makePort();
    let identityKnown = false;
    const targetRouter = {
      getPlaneForMachine: (machineId: MachineId) =>
        identityKnown ? (machineId === LOCAL ? ('local' as const) : ('cloud' as const)) : null,
    };
    const monitor = new TargetRoutedMachineMonitor(targetRouter, cloud.port);
    monitor.setLocalTransport(local.port);
    const localListener = vi.fn();
    const remoteListener = vi.fn();

    monitor.subscribeMachine(LOCAL, localListener);
    monitor.subscribeMachine(REMOTE, remoteListener);
    expect(local.subscribeMachine).not.toHaveBeenCalled();
    expect(cloud.subscribeMachine).not.toHaveBeenCalled();

    identityKnown = true;
    monitor.refreshRoutes();
    expect(local.subscribeMachine).toHaveBeenCalledWith(LOCAL, localListener);
    expect(cloud.subscribeMachine).toHaveBeenCalledWith(REMOTE, remoteListener);

    monitor.forceSample(LOCAL);
    monitor.forceSample(REMOTE);
    expect(local.forceSample).toHaveBeenCalledWith(LOCAL);
    expect(cloud.forceSample).toHaveBeenCalledWith(REMOTE);
  });

  it('rebinds subscriptions when local ownership changes', () => {
    const cloud = makePort();
    const local = makePort();
    let localMachineId: MachineId | null = LOCAL;
    const targetRouter = {
      getPlaneForMachine: (machineId: MachineId) =>
        machineId === localMachineId ? ('local' as const) : ('cloud' as const),
    };
    const monitor = new TargetRoutedMachineMonitor(targetRouter, cloud.port);
    monitor.setLocalTransport(local.port);
    monitor.subscribeMachine(LOCAL, vi.fn());

    localMachineId = null;
    monitor.refreshRoutes();

    expect(local.unsubscribe).toHaveBeenCalledTimes(1);
    expect(cloud.subscribeMachine).toHaveBeenCalledWith(LOCAL, expect.any(Function));
  });
});
