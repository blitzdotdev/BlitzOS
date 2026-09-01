import type { MachineId, MachineMonitorSnapshot } from '@lody/shared';
import type { WorkspaceTargetRouter } from './workspace-target-router';

export type MachineMonitorTransportPort = {
  subscribeMachine: (
    machineId: MachineId,
    listener: (snapshot: MachineMonitorSnapshot | null) => void
  ) => () => void;
  forceSample: (machineId: MachineId) => void;
};

type Subscription = {
  machineId: MachineId;
  listener: (snapshot: MachineMonitorSnapshot | null) => void;
  unsubscribe: (() => void) | null;
};

export class TargetRoutedMachineMonitor {
  private local: MachineMonitorTransportPort | null = null;
  private readonly subscriptions = new Set<Subscription>();

  constructor(
    private readonly router: Pick<WorkspaceTargetRouter, 'getPlaneForMachine'>,
    private readonly cloud: MachineMonitorTransportPort
  ) {}

  setLocalTransport(local: MachineMonitorTransportPort): void {
    this.local = local;
    this.rebindAll();
  }

  refreshRoutes(): void {
    this.rebindAll();
  }

  subscribeMachine(
    machineId: MachineId,
    listener: (snapshot: MachineMonitorSnapshot | null) => void
  ): () => void {
    const subscription: Subscription = { machineId, listener, unsubscribe: null };
    this.subscriptions.add(subscription);
    this.bind(subscription);
    return () => {
      this.subscriptions.delete(subscription);
      subscription.unsubscribe?.();
      subscription.unsubscribe = null;
    };
  }

  forceSample(machineId: MachineId): void {
    this.resolve(machineId)?.forceSample(machineId);
  }

  private rebindAll(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe?.();
      subscription.unsubscribe = null;
      this.bind(subscription);
    }
  }

  private bind(subscription: Subscription): void {
    subscription.unsubscribe =
      this.resolve(subscription.machineId)?.subscribeMachine(
        subscription.machineId,
        subscription.listener
      ) ?? null;
  }

  private resolve(machineId: MachineId): MachineMonitorTransportPort | null {
    const plane = this.router.getPlaneForMachine(machineId);
    if (!plane) return null;
    return plane === 'local' ? this.local : this.cloud;
  }
}
