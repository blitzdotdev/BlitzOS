import { useState } from "react";
import type { StandalonePorts } from "./resolver.js";
import { DEFAULT_PORTS, validPort } from "./resolver.js";

const PORTS_KEY = "blitz.webapp.ports.v1";

function readJson<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    // SAFETY: JSON parsing establishes valid JSON only; caller-selected T is not checked. TODO(deslop-tier-c): require a decoder for each persisted device-state value.
    return stored === null ? fallback : (JSON.parse(stored) as T);
  } catch {
    return fallback;
  }
}

export function useStandalonePorts(): [StandalonePorts, (ports: StandalonePorts) => void] {
  const [ports, setPorts] = useState<StandalonePorts>(() => {
    const stored = readJson<Partial<StandalonePorts>>(PORTS_KEY, {});
    return {
      // SAFETY: validPort establishes a finite integer in the supported TCP port range.
      acp: validPort(stored.acp ?? 0) ? (stored.acp as number) : DEFAULT_PORTS.acp,
      // SAFETY: validPort establishes a finite integer in the supported TCP port range.
      files: validPort(stored.files ?? 0) ? (stored.files as number) : DEFAULT_PORTS.files,
    };
  });
  const update = (next: StandalonePorts): void => {
    setPorts(next);
    localStorage.setItem(PORTS_KEY, JSON.stringify(next));
  };
  return [ports, update];
}
