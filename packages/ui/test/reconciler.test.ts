import type { WorkspaceView } from "@blitzos/schema";
import { describe, expect, it } from "vitest";
import { reconcileWorkspaces } from "../src/reconciler.js";

function workspace(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    id: "workspace-1",
    phase: "ready",
    retryAction: null,
    canObserve: true,
    launchable: true,
    revision: 12,
    ssh: { host: "new.example", port: 22, user: "blitz", hostPublicKey: "key" },
    volumeId: null,
    error: null,
    ...overrides,
  };
}

describe("workspace reconciler", () => {
  it("drops a delayed stale revision", () => {
    const current = workspace();
    const delayed = workspace({
      revision: 11,
      phase: "error",
      retryAction: "destroy",
      canObserve: false,
      launchable: false,
      ssh: { host: "old.example", port: 2200, user: "old", hostPublicKey: null },
      error: "old failure",
    });

    const [result] = reconcileWorkspaces([current], [delayed]);

    expect(result).toBe(current);
    expect(result?.revision).toBe(12);
    expect(result?.ssh?.host).toBe("new.example");
  });

  it("adds and removes rows and replaces every field from a newer view", () => {
    const current = workspace();
    const removed = workspace({ id: "removed" });
    const newer = workspace({
      revision: 13,
      phase: "error",
      retryAction: "destroy",
      canObserve: false,
      launchable: false,
      ssh: null,
      error: "provider failed",
    });
    const added = workspace({ id: "added", revision: 1, phase: "creating", retryAction: "poll" });

    expect(reconcileWorkspaces([current, removed], [newer, added])).toEqual([newer, added]);
  });
});
