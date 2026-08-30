import type {
  MachineMonitorMeasurementQuality,
  MachineMonitorMemoryKind,
  MachineMonitorResourceUsage,
} from '@lody/shared';

export type CumulativeResourceSample = {
  memoryBytes: number | null;
  cpuTimeMicros: number | null;
  processCount: number | null;
  memoryKind: MachineMonitorMemoryKind;
  quality: MachineMonitorMeasurementQuality;
};

export type DeviceCpuTimeSample = {
  busyMs: number;
  totalMs: number;
};

export function toDeviceCpuCores(
  current: DeviceCpuTimeSample,
  previous: DeviceCpuTimeSample | null,
  logicalCpuCount: number
): number | null {
  if (!previous) return null;
  const busyDelta = current.busyMs - previous.busyMs;
  const totalDelta = current.totalMs - previous.totalMs;
  if (busyDelta < 0 || totalDelta <= 0) return null;
  return (Math.min(busyDelta, totalDelta) / totalDelta) * Math.max(1, logicalCpuCount);
}

export function toResourceUsage(args: {
  current: CumulativeResourceSample;
  previousCpuTimeMicros: number | null;
  windowMs: number | null;
  logicalCpuCount: number;
}): MachineMonitorResourceUsage {
  const { current, previousCpuTimeMicros, windowMs, logicalCpuCount } = args;
  let cpuCores: number | null = null;
  if (
    current.cpuTimeMicros !== null &&
    previousCpuTimeMicros !== null &&
    windowMs !== null &&
    windowMs > 0 &&
    current.cpuTimeMicros >= previousCpuTimeMicros
  ) {
    cpuCores = (current.cpuTimeMicros - previousCpuTimeMicros) / (windowMs * 1_000);
  }
  return {
    memoryBytes: current.memoryBytes,
    cpuCores,
    cpuPercentOfMachine: cpuCores === null ? null : (cpuCores / Math.max(1, logicalCpuCount)) * 100,
    processCount: current.processCount,
    memoryKind: current.memoryKind,
    quality: current.quality,
  };
}

export function sumResourceUsage(
  resources: readonly MachineMonitorResourceUsage[]
): MachineMonitorResourceUsage {
  const memoryKind = resolveAggregateMemoryKind(resources);
  const availableMemory = resources.flatMap((resource) =>
    resource.memoryBytes === null ? [] : [resource.memoryBytes]
  );
  const availableCpu = resources.flatMap((resource) =>
    resource.cpuCores === null ? [] : [resource.cpuCores]
  );
  const availableProcesses = resources.flatMap((resource) =>
    resource.processCount === null ? [] : [resource.processCount]
  );
  const quality = resolveAggregateQuality(resources);
  const cpuCores = availableCpu.length > 0 ? sum(availableCpu) : null;
  return {
    memoryBytes: availableMemory.length > 0 ? sum(availableMemory) : null,
    cpuCores,
    cpuPercentOfMachine: null,
    processCount: availableProcesses.length > 0 ? sum(availableProcesses) : null,
    memoryKind,
    quality,
  };
}

export function resolveAggregateMemoryKind(
  resources: readonly MachineMonitorResourceUsage[]
): MachineMonitorMemoryKind {
  const kinds = new Set(
    resources
      .filter((resource) => resource.memoryBytes !== null)
      .map((resource) => normalizeAggregateMemoryKind(resource.memoryKind))
      .filter((kind) => kind !== 'unavailable')
  );
  if (kinds.size === 0) return 'unavailable';
  if (kinds.size > 1) return 'mixed';
  return kinds.values().next().value ?? 'unavailable';
}

export function withMachineCpuPercent(
  resource: MachineMonitorResourceUsage,
  logicalCpuCount: number
): MachineMonitorResourceUsage {
  return {
    ...resource,
    cpuPercentOfMachine:
      resource.cpuCores === null ? null : (resource.cpuCores / Math.max(1, logicalCpuCount)) * 100,
  };
}

function resolveAggregateQuality(
  resources: readonly MachineMonitorResourceUsage[]
): MachineMonitorMeasurementQuality {
  const qualities = new Set(resources.map((resource) => resource.quality));
  if (qualities.size === 0 || (qualities.size === 1 && qualities.has('unavailable'))) {
    return 'unavailable';
  }
  if (qualities.size === 1 && qualities.has('exact-cgroup')) return 'exact-cgroup';
  if (qualities.size === 1 && qualities.has('exact-process')) return 'exact-process';
  return 'estimated-tree';
}

function normalizeAggregateMemoryKind(
  memoryKind: MachineMonitorMemoryKind
): MachineMonitorMemoryKind {
  if (memoryKind === 'rss') return 'rss-sum';
  if (memoryKind === 'physical-footprint') return 'physical-footprint-sum';
  return memoryKind;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
