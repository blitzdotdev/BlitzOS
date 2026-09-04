import { describe, expect, it } from "vitest";
import type { TenantMe } from "../src/api-adapter.js";
import { workspaceFromWire } from "../src/api-adapter.js";
import type { UiPreferences } from "../src/storage.js";
import { initialWorkspaceStore, workspaceReducer } from "../src/workspace-store.js";
import { workspaceViewFixture } from "./workspace-fixtures.js";

const viewer: TenantMe = {
  identity: { id: "identity-1", email: "owner@example.com", name: "Owner", avatarUrl: null },
  membership: { id: "membership-1", role: "admin" },
  org: { id: "org-1", slug: "example", name: "Example", vmLimit: 10 },
  organizations: [{
    membership: { id: "membership-1", role: "admin" },
    org: { id: "org-1", slug: "example", name: "Example", vmLimit: 10 },
  }],
};

const preferences: UiPreferences = {
  version: 1,
  activeWorkspaceId: "",
  railWidth: 260,
  order: [],
  workspaces: {},
};

function load(phase: "ready" | "destroying") {
  return workspaceReducer(initialWorkspaceStore, {
    type: "workspaces_loaded",
    records: [workspaceFromWire(workspaceViewFixture({ id: "workspace-one", phase }))],
    viewer,
    preferences,
  });
}

describe("workspace store", () => {
  /**
   * The rail bug this repairs: confirming a machine-type change took the
   * workspace off the rail until a page refresh, so it read as deleted.
   *
   * `WorkspaceView.phase` is projected from the REQUESTING member's machine
   * (`core/workspace-records.ts`), and a machine-type change, a stop and a
   * recreate all destroy the VM on the same volume — so each reports
   * `destroying` while the workspace row is untouched.
   */
  it("keeps a workspace whose machine is being replaced", () => {
    const state = load("destroying");
    expect(state.workspaces.map(({ id }) => id)).toEqual(["workspace-one"]);
    expect(state.workspaces[0]?.lifecycleStatus).toBe("destroying");
  });

  /**
   * THE 409 ON OPEN (Brandon, 2026-09-03). The control plane projects a
   * STOPPED member machine as phase `ready` so the workspace stays on the rail
   * and still starts; read as `running`, that made the shell dial a box with
   * no VM and collect a 409 from every call. The viewer's own row in `members`
   * says what the phase cannot, and it is the viewer's row alone that counts.
   */
  it("reads the viewer's own stopped machine as stopped, and nobody else's", () => {
    const machine = (membershipId: string, state: "running" | "stopped") => ({
      id: `machine-${membershipId}`,
      state,
      machineTypeId: "cx23@fsn1",
      volumeId: "volume-1",
      volumeUsedPercent: null,
      membershipId,
      error: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const member = (membershipId: string, state: "running" | "stopped") => ({
      membershipId,
      name: membershipId,
      avatarUrl: null,
      role: "member" as const,
      machine: machine(membershipId, state),
    });
    const records = (mine: "running" | "stopped", theirs: "running" | "stopped") => [
      workspaceFromWire(workspaceViewFixture({
        id: "workspace-one",
        phase: "ready",
        members: [member("membership-1", mine), member("membership-2", theirs)],
      })),
    ];
    const loaded = workspaceReducer(initialWorkspaceStore, {
      type: "workspaces_loaded",
      records: records("stopped", "running"),
      viewer,
      preferences,
    });
    expect(loaded.workspaces[0]?.lifecycleStatus).toBe("stopped");

    // Another member's stopped machine is their pane, not this viewer's.
    const theirs = workspaceReducer(initialWorkspaceStore, {
      type: "workspaces_loaded",
      records: records("running", "stopped"),
      viewer,
      preferences,
    });
    expect(theirs.workspaces[0]?.lifecycleStatus).toBe("running");

    // The poll's per-record update takes the same reading, so a machine that
    // stops while the workspace is open does not keep reading as running.
    const stoppedLater = workspaceReducer(theirs, {
      type: "workspace_record_updated",
      record: records("stopped", "running")[0]!,
    });
    expect(stoppedLater.workspaces[0]?.lifecycleStatus).toBe("stopped");
    // And the refresh path, which projects over the existing model.
    const refreshed = workspaceReducer(loaded, {
      type: "workspace_records_refreshed",
      records: records("running", "running"),
    });
    expect(refreshed.workspaces[0]?.lifecycleStatus).toBe("running");
  });

  it("drops a workspace only when it is actually deleted", () => {
    const state = workspaceReducer(load("ready"), {
      type: "workspace_deleted",
      workspaceId: "workspace-one",
    });
    expect(state.workspaces).toEqual([]);
  });
});
