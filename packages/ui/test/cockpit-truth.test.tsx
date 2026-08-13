import type { WorkspaceView } from "@blitzos/schema";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlaneClient } from "../src/api.js";
import { Cockpit } from "../src/Cockpit.js";
import { standaloneResolver } from "../src/resolver.js";
import { render, settle } from "./dom.js";

function workspace(id: string, phase: WorkspaceView["phase"]): WorkspaceView {
  return {
    id,
    phase,
    retryAction: null,
    canObserve: false,
    launchable: false,
    revision: 1,
    ssh: null,
    volumeId: null,
    error: null,
  };
}

function client(workspaces: WorkspaceView[]): ControlPlaneClient {
  return {
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    poll: vi.fn(async () => ({ workspaces })),
    create: vi.fn(async () => { throw new Error("not used"); }),
    destroy: vi.fn(async () => { throw new Error("not used"); }),
    listMachineTypes: vi.fn(async () => ({ machineTypes: [] })),
    listVolumes: vi.fn(async () => ({ volumes: [] })),
  };
}

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
});

describe("cockpit connection truth", () => {
  it("starts not connected, hides destroyed rows, and never auto-selects a workspace", async () => {
    const view = await render(
      <Cockpit
        client={client([
          workspace("ready-workspace", "ready"),
          workspace("destroyed-workspace", "destroyed"),
        ])}
        resolver={standaloneResolver({ terminal: 8443, acp: 8444, files: 8445 })}
      />,
    );
    await settle();

    expect(view.container.querySelector("h1")?.textContent).toBe("Not connected");
    expect(view.container.querySelector('[data-connection-state="not-connected"]')?.textContent)
      .toContain("Select a workspace to connect.");
    const rail = view.container.querySelector('nav[aria-label="Workspaces"]');
    expect(rail?.textContent).toContain("ready-wo");
    expect(rail?.textContent).not.toContain("destroye");
    expect(view.container.querySelector(".workspace-button.selected")).toBeNull();

    const showDestroyed = [...view.container.querySelectorAll("button")]
      .find(({ textContent }) => textContent === "Show destroyed (1)");
    await act(async () => showDestroyed?.click());
    expect(rail?.textContent).toContain("destroye");
    expect(view.container.querySelector(".workspace-button.selected")).toBeNull();

    await view.unmount();
  });

  it("shows the resolver host:port on every workspace surface", async () => {
    const view = await render(
      <Cockpit
        client={client([workspace("ready-workspace", "ready")])}
        resolver={standaloneResolver({ terminal: 8443, acp: 8444, files: 8445 })}
      />,
    );
    await settle();
    const workspaceButton = view.container.querySelector<HTMLButtonElement>(".workspace-button");
    await act(async () => workspaceButton?.click());

    const tabs = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((button) => button.querySelector("small")?.textContent)).toEqual([
      "localhost:8443",
      "localhost:8444",
      "localhost:8445",
      "localhost:3000",
    ]);

    await view.unmount();
  });
});
