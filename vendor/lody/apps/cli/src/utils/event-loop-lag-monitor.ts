import type { Logger } from './logger';

export type EventLoopLagMonitor = {
  stop: () => void;
};

export function startEventLoopLagMonitor(
  logger: Logger,
  options: {
    label: string;
    intervalMs?: number;
    warnThresholdMs?: number;
  }
): EventLoopLagMonitor {
  const intervalMs = Math.max(100, options.intervalMs ?? 1_000);
  const warnThresholdMs = Math.max(intervalMs, options.warnThresholdMs ?? 5_000);
  let expectedAt = Date.now() + intervalMs;
  let previousTickAt = Date.now();
  let previousCpuUsage = process.cpuUsage();

  const timer = setInterval(() => {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - previousTickAt);
    const lagMs = now - expectedAt;
    const cpuUsage = process.cpuUsage();
    const cpuMs =
      (cpuUsage.user - previousCpuUsage.user + cpuUsage.system - previousCpuUsage.system) / 1000;
    const cpuRatio = elapsedMs > 0 ? cpuMs / elapsedMs : 0;

    previousTickAt = now;
    previousCpuUsage = cpuUsage;
    expectedAt = now + intervalMs;

    if (lagMs >= warnThresholdMs) {
      const memoryUsage = process.memoryUsage();
      logger.warn(
        `[event-loop] ${options.label} timer lag detected: fired ${Math.round(
          lagMs
        )}ms late (threshold=${warnThresholdMs}ms interval=${intervalMs}ms elapsed=${Math.round(
          elapsedMs
        )}ms cpu=${Math.round(cpuMs)}ms cpuRatio=${cpuRatio.toFixed(2)} rss=${Math.round(
          memoryUsage.rss / 1024 / 1024
        )}MiB heapUsed=${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MiB)`
      );
    }
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
