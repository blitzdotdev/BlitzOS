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

  it("drops a workspace only when it is actually deleted", () => {
    const state = workspaceReducer(load("ready"), {
      type: "workspace_deleted",
      workspaceId: "workspace-one",
    });
    expect(state.workspaces).toEqual([]);
  });
});
