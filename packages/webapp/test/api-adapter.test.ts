import type { WorkspaceView } from "@blitzos/schema";
import { describe, expect, it, vi } from "vitest";
import {
  ApiAdapter,
  synthesizePersonalMe,
  workspaceFromWire,
} from "../src/api-adapter.js";
import type { ControlPlaneClient } from "../src/api.js";

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
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
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
    expect(workspaceFromWire(workspace("ready", null))).toMatchObject({
      status: "running",
      canControl: true,
      ownerMembershipId: "personal",
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

  it("synthesizes a stable personal org and membership", () => {
    expect(synthesizePersonalMe()).toMatchObject({
      membership: { id: "personal", role: "admin" },
      org: { id: "personal", slug: "personal", name: "Personal" },
    });
  });

  it("uses the bootstrap list as adapter me and sends a keyless create body unchanged", async () => {
    const poll = vi.fn(async () => ({ workspaces: [workspace("ready", null)] }));
    const create = vi.fn(async () => ({ workspace: workspace("creating", "poll") }));
    const adapter = new ApiAdapter(client({ poll, create }), () => undefined);

    expect((await adapter.getMe()).org.id).toBe("personal");
    expect((await adapter.listWorkspaces()).map(({ status }) => status)).toEqual(["running"]);
    expect(poll).toHaveBeenCalledOnce();

    await adapter.createWorkspace({ machineTypeId: "mv-2c2g@lab" });
    expect(create).toHaveBeenCalledWith({ machineTypeId: "mv-2c2g@lab" });
  });
});
