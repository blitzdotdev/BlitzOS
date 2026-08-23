import type { WorkspaceView } from "@blitzos/schema";
import { describe, expect, it } from "vitest";
import type { MeResponse } from "../src/api.js";
import { isTenantMe, meFromWire, type TenantMe } from "../src/protocol.js";
import {
  initialWorkspaceStore,
  workspaceReducer,
} from "../src/workspace-store.js";
import type { UiPreferences } from "../src/storage.js";

function workspace(phase: WorkspaceView["phase"], retryAction: WorkspaceView["retryAction"]): WorkspaceView {
  return {
    id: `workspace-${phase}`,
    name: `name-${phase}`,
    machineTypeId: "mv-2c2g@lab",
    phase,
    retryAction,
    canObserve: phase === "ready",
    launchable: phase === "ready",
    revision: 7,
    ssh: null,
    volumeId: null,
    error: phase === "error" ? "provider failed" : null,
    role: "owner",
    orgShareRole: null,
    connections: [],
    owner: { name: "Owner", avatarUrl: null },
    environment: null,
    agentRuleId: null,
  };
}

const wireMe: MeResponse = {
  user: {
    id: "user-one",
    email: "person@example.com",
    name: "Person",
    avatarUrl: null,
    platformOperator: false,
  },
  membership: { id: "membership-one", role: "admin", status: "active" },
  org: { id: "org-one", slug: "example", name: "Example", vmLimit: 10 },
  organizations: [{
    membership: { id: "membership-one", role: "admin", status: "active" },
    org: { id: "org-one", slug: "example", name: "Example", vmLimit: 10 },
  }],
};

const viewer: TenantMe = {
  identity: { id: "user-one", email: "person@example.com", name: "Person", avatarUrl: null },
  membership: { id: "membership-one", role: "admin" },
  org: { id: "org-one", slug: "example", name: "Example", vmLimit: 10 },
  organizations: [],
};

const preferences: UiPreferences = {
  version: 1,
  activeWorkspaceId: "",
  railWidth: 240,
  order: [],
  workspaces: {},
};

describe("wire workspace views in the store", () => {
  it("maps blitz phases and filters terminal phases", () => {
    const state = workspaceReducer(initialWorkspaceStore, {
      type: "workspaces_loaded",
      records: [
        workspace("ready", null),
        workspace("creating", "poll"),
        workspace("error", "destroy"),
        workspace("destroying", "poll"),
        workspace("destroyed", "create"),
      ],
      viewer,
      preferences,
    });
    expect(state.workspaces.map(({ id, lifecycleStatus }) => [id, lifecycleStatus])).toEqual([
      ["workspace-ready", "running"],
      ["workspace-creating", "creating"],
      ["workspace-error", "error"],
    ]);
    expect(state.workspaces[0]).toMatchObject({
      canControl: true,
      machineType: "mv-2c2g@lab",
      updatedAt: 7,
    });
    expect(state.workspaces[2]).toMatchObject({
      errorDetail: "provider failed",
      retryAction: "destroy",
    });
  });

  it("marks role-less views uncontrollable and keeps the server name as title", () => {
    const shared: WorkspaceView = { ...workspace("ready", null), role: null };
    const state = workspaceReducer(initialWorkspaceStore, {
      type: "workspaces_loaded",
      records: [shared],
      viewer,
      preferences,
    });
    expect(state.workspaces[0]).toMatchObject({
      canControl: false,
      title: "name-ready",
    });
  });

  it("maps /me to the viewer view and detects tenant membership", () => {
    const me = meFromWire(wireMe);
    expect(me.identity).toEqual({
      id: "user-one",
      email: "person@example.com",
      name: "Person",
      avatarUrl: null,
      platformOperator: false,
    });
    expect(isTenantMe(me)).toBe(true);
    expect(isTenantMe(meFromWire({ ...wireMe, membership: null, org: null }))).toBe(false);
  });
});
