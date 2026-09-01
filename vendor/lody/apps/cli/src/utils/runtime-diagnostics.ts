import os from 'node:os';
import v8 from 'node:v8';

type JavaScriptRuntimeName = 'node' | 'bun' | 'deno';

type JavaScriptRuntimeInfo = {
  name: JavaScriptRuntimeName;
  version: string;
};

type RuntimeGlobals = typeof globalThis & {
  Bun?: { version?: string };
  Deno?: { version?: { deno?: string } };
};

const readEnvValue = (name: string): string => process.env[name]?.trim() || '<unset>';

export function detectJavaScriptRuntime(): JavaScriptRuntimeInfo {
  const runtimeGlobals = globalThis as RuntimeGlobals;
  const bunVersion =
    typeof process.versions.bun === 'string' && process.versions.bun.length > 0
      ? process.versions.bun
      : runtimeGlobals.Bun?.version;
  if (bunVersion) {
    return { name: 'bun', version: bunVersion };
  }

  const denoVersion = runtimeGlobals.Deno?.version?.deno;
  if (denoVersion) {
    return { name: 'deno', version: denoVersion };
  }

  return { name: 'node', version: process.versions.node };
}

export function getRuntimeDiagnostics(cliVersion: string): string[] {
  const jsRuntime = detectJavaScriptRuntime();
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? 'unknown CPU';
  const totalMemoryMiB = Math.round(os.totalmem() / 1024 / 1024);
  const heapLimitMiB = Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024);
  const memoryUsage = process.memoryUsage();
  const heapUsedMiB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
  const rssMiB = Math.round(memoryUsage.rss / 1024 / 1024);

  return [
    `Lody CLI v${cliVersion}`,
    `Runtime: ${jsRuntime.name} ${jsRuntime.version}; node ${process.versions.node}; v8 ${process.versions.v8}`,
    `System: ${os.type()} ${os.release()} (${process.platform}/${process.arch}); ${cpuModel}; cpus=${cpus.length}; memory=${totalMemoryMiB}MiB`,
    `Process: pid=${process.pid}; ppid=${process.ppid}; execPath=${process.execPath}; cwd=${process.cwd()}`,
    `Heap: limit=${heapLimitMiB}MiB; used=${heapUsedMiB}MiB; rss=${rssMiB}MiB; execArgv=${JSON.stringify(process.execArgv)}`,
    `Environment: NODE_ENV=${readEnvValue('NODE_ENV')}; LODY_ENV=${readEnvValue('LODY_ENV')}`,
  ];
}
