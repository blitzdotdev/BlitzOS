import { useState } from "react";
import type { StandalonePorts } from "./resolver.js";
import { DEFAULT_PORTS, validPort } from "./resolver.js";

const PORTS_KEY = "blitz.cockpit.ports.v1";

function readJson<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : (JSON.parse(stored) as T);
  } catch {
    return fallback;
  }
}

export function useStandalonePorts(): [StandalonePorts, (ports: StandalonePorts) => void] {
  const [ports, setPorts] = useState<StandalonePorts>(() => {
    const stored = readJson<Partial<StandalonePorts>>(PORTS_KEY, {});
    return {
      acp: validPort(stored.acp ?? 0) ? (stored.acp as number) : DEFAULT_PORTS.acp,
      files: validPort(stored.files ?? 0) ? (stored.files as number) : DEFAULT_PORTS.files,
    };
  });
  const update = (next: StandalonePorts): void => {
    setPorts(next);
    localStorage.setItem(PORTS_KEY, JSON.stringify(next));
  };
  return [ports, update];
}
