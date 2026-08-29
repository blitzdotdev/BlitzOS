import {
  LODY_MACHINE_MONITOR_MACOS_SAMPLE_MS,
  LODY_MACHINE_MONITOR_UNIX_SAMPLE_MS,
  LODY_MACHINE_MONITOR_WINDOWS_SAMPLE_MS,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { getMemoryPressureSnapshot, type MemoryPressureSnapshot } from '@/utils/memory';

export type MemoryPressureSnapshotSource = {
  getLatest(): Promise<MemoryPressureSnapshot>;
  refresh(): Promise<MemoryPressureSnapshot>;
};

type MemoryPressureSamplerOptions = {
  /**
   * `force` asks the probe to bypass any platform-level cache of its own. The periodic sweep
   * passes `false` (the Windows commit probe is a `powershell.exe` spawn); every path that is
   * about to act on the result passes `true`.
   */
  probe?: (force: boolean) => Promise<MemoryPressureSnapshot>;
  now?: () => number;
  sampleIntervalMs?: number;
  maxStaleMs?: number;
};

function platformSampleIntervalMs(): number {
  return process.platform === 'win32'
    ? LODY_MACHINE_MONITOR_WINDOWS_SAMPLE_MS
    : process.platform === 'darwin'
      ? LODY_MACHINE_MONITOR_MACOS_SAMPLE_MS
      : LODY_MACHINE_MONITOR_UNIX_SAMPLE_MS;
}

/**
 * Process-wide memory sampler shared by every workspace runtime.
 *
 * OS probes such as macOS `vm_stat` are intentionally kept off the prompt hot
 * path. A bounded-staleness snapshot is safe for the GC admission heuristic;
 * actual eviction always forces a fresh sample before deciding whether to
 * evict another session.
 */
export class MemoryPressureSampler implements MemoryPressureSnapshotSource {
  private readonly probe: (force: boolean) => Promise<MemoryPressureSnapshot>;
  private readonly now: () => number;
  private readonly sampleIntervalMs: number;
  private readonly maxStaleMs: number;
  private cached: { snapshot: MemoryPressureSnapshot; sampledAtMs: number } | null = null;
  private inFlight: { promise: Promise<MemoryPressureSnapshot>; forced: boolean } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: Logger,
    options: MemoryPressureSamplerOptions = {}
  ) {
    this.probe = options.probe ?? ((force) => getMemoryPressureSnapshot({ force }));
    this.now = options.now ?? (() => performance.now());
    this.sampleIntervalMs = options.sampleIntervalMs ?? platformSampleIntervalMs();
    this.maxStaleMs = options.maxStaleMs ?? this.sampleIntervalMs * 3;
  }

  start(): void {
    if (this.timer) return;
    void this.sample(false).catch((error: unknown) => {
      this.logger.debug(`Initial memory pressure sample failed: ${formatErrorMessage(error)}`);
    });
    this.timer = setInterval(() => {
      void this.sample(false).catch((error: unknown) => {
        this.logger.debug(`Memory pressure sample failed: ${formatErrorMessage(error)}`);
      });
    }, this.sampleIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async getLatest(): Promise<MemoryPressureSnapshot> {
    const cached = this.cached;
    if (!cached) {
      return await this.sample(false);
    }

    const ageMs = Math.max(0, this.now() - cached.sampledAtMs);
    if (ageMs >= this.sampleIntervalMs) {
      void this.sample(false).catch((error: unknown) => {
        this.logger.debug(`Memory pressure refresh failed: ${formatErrorMessage(error)}`);
      });
    }
    if (ageMs <= this.maxStaleMs) {
      return cached.snapshot;
    }
    return await this.sample(false);
  }

  /**
   * Take a sample that every platform probe must answer freshly. Callers reach for this when
   * they are about to ACT on the result, so a cached OS reading is not good enough.
   */
  async refresh(): Promise<MemoryPressureSnapshot> {
    return await this.sample(true);
  }

  private async sample(force: boolean): Promise<MemoryPressureSnapshot> {
    // A forced caller may join an in-flight sample only if that sample was itself forced;
    // otherwise it could adopt a platform-cached reading it explicitly asked to bypass.
    const inFlight = this.inFlight;
    if (inFlight !== null && (!force || inFlight.forced)) {
      return await inFlight.promise;
    }

    const promise = this.probe(force).then((snapshot) => {
      this.cached = { snapshot, sampledAtMs: this.now() };
      return snapshot;
    });
    const operation = { promise, forced: force };
    this.inFlight = operation;
    try {
      return await promise;
    } finally {
      if (this.inFlight === operation) {
        this.inFlight = null;
      }
    }
  }
}
