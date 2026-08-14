import { useEffect, useState } from "react";
import type { StandalonePorts } from "./resolver.js";
import { DEFAULT_PORTS, validPort } from "./resolver.js";

const PORTS_KEY = "blitz.cockpit.ports.v1";
const LAYOUT_KEY = "blitz.cockpit.layout.v1";

export type CockpitTab = "terminal" | "chat" | "files" | "preview" | "leases";

interface LayoutState {
  tabs: Record<string, CockpitTab>;
}

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
      terminal: validPort(stored.terminal ?? 0) ? (stored.terminal as number) : DEFAULT_PORTS.terminal,
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

export function useWorkspaceTab(workspaceId: string | null): [CockpitTab, (tab: CockpitTab) => void] {
  const [layout, setLayout] = useState<LayoutState>(() => readJson(LAYOUT_KEY, { tabs: {} }));
  const tab = workspaceId === null ? "terminal" : (layout.tabs[workspaceId] ?? "terminal");
  const setTab = (next: CockpitTab): void => {
    if (workspaceId === null) return;
    setLayout((current) => ({ ...current, tabs: { ...current.tabs, [workspaceId]: next } }));
  };
  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  }, [layout]);
  return [tab, setTab];
}
