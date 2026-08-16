import type { WorkspaceView } from "@blitzos/schema";
import { describe, expect, it, vi } from "vitest";
import {
  ApiAdapter,
  workspaceFromWire,
} from "../src/api-adapter.js";
import type { ControlPlaneClient } from "../src/api.js";
import { defaultGlobalWebAppState, defaultWorkspaceWebAppState } from "../src/storage.js";

function workspace(phase: WorkspaceView["phase"], retryAction: WorkspaceView["retryAction"]): WorkspaceView {
  return {
    id: `workspace-${phase}`,
    machineTypeId: "mv-2c2g@lab",
    phase,
    retryAction,
    canObserve: phase === "ready",
    launchable: phase === "ready",
    revision: 7,
    ssh: null,
    volumeId: null,
    error: phase === "error" ? "provider failed" : null,
  };
}

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    googleLoginUrl: () => "/auth/google/start",
    logout: vi.fn(async () => undefined),
    me: vi.fn(async () => ({
      user: {
        id: "user-one",
        email: "person@example.com",
        name: "Person",
        avatarUrl: null,
        platformOperator: false,
      },
      membership: { id: "membership-one", role: "admin" as const, status: "active" as const },
      org: { id: "org-one", slug: "example", name: "Example", vmLimit: 10 },
    })),
    createOrg: vi.fn(async () => ({
      org: { id: "org-one", slug: "example", name: "Example", vmLimit: 10 },
      membership: { id: "membership-one", role: "admin" as const, status: "active" as const },
    })),
    getGlobalWebAppState: vi.fn(async () => ({ doc: null, updatedAt: null })),
    putGlobalWebAppState: vi.fn(async (doc) => ({ doc, updatedAt: 1 })),
    getWorkspaceWebAppState: vi.fn(async () => ({ doc: null, updatedAt: null })),
    putWorkspaceWebAppState: vi.fn(async (_id, doc) => ({ doc, updatedAt: 1 })),
    poll: vi.fn(async () => ({ workspaces: [] })),
    create: vi.fn(async () => ({ workspace: workspace("creating", "poll") })),
    destroy: vi.fn(async () => ({ workspace: workspace("destroying", "poll") })),
    listMachineTypes: vi.fn(async () => ({ machineTypes: [], failures: [] })),
    listVolumes: vi.fn(async () => ({ volumes: [] })),
    listIntegrations: vi.fn(async () => ({ integrations: [] })),
    putIntegration: vi.fn(async () => undefined),
    deleteIntegration: vi.fn(async () => undefined),
    listLeases: vi.fn(async () => ({ leases: [] })),
    revokeLease: vi.fn(async () => undefined),
    listCredentialRequests: vi.fn(async () => ({ requests: [] })),
    approveCredentialRequest: vi.fn(async () => undefined),
    denyCredentialRequest: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("webapp API adapter", () => {
  it("maps blitz phases and filters terminal phases", () => {
    expect(workspaceFromWire(workspace("ready", null), "membership-one")).toMatchObject({
      status: "running",
      canControl: true,
      ownerMembershipId: "membership-one",
      machineType: "mv-2c2g@lab",
    });
    expect(workspaceFromWire(workspace("creating", "poll"))?.status).toBe("creating");
    expect(workspaceFromWire(workspace("error", "destroy"))).toMatchObject({
      status: "error",
      errorDetail: "provider failed",
      retryAction: "destroy",
    });
    expect(workspaceFromWire(workspace("destroying", "poll"))).toBeNull();
    expect(workspaceFromWire(workspace("destroyed", "create"))).toBeNull();
  });

  it("uses real identity data and sends a keyless create body unchanged", async () => {
    const poll = vi.fn(async () => ({ workspaces: [workspace("ready", null)] }));
    const create = vi.fn(async () => ({ workspace: workspace("creating", "poll") }));
    const adapter = new ApiAdapter(client({ poll, create }), () => undefined);

    expect((await adapter.getMe()).org?.id).toBe("org-one");
    expect((await adapter.listWorkspaces()).map(({ status }) => status)).toEqual(["running"]);
    expect(poll).toHaveBeenCalledOnce();

    await adapter.createWorkspace({ machineTypeId: "mv-2c2g@lab" });
    expect(create).toHaveBeenCalledWith({ machineTypeId: "mv-2c2g@lab" });

    await adapter.putGlobalWebAppState(defaultGlobalWebAppState());
    await adapter.putWorkspaceWebAppState("workspace-ready", defaultWorkspaceWebAppState());
  });
});
