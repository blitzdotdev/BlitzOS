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

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    googleLoginUrl: () => "/auth/google/start",
    inviteGoogleLoginUrl: (code) => `/auth/google/start?invite=${code}`,
    inviteStatus: vi.fn(async () => { throw new Error("unused"); }),
    switchOrg: vi.fn(async () => undefined),
    listMembers: vi.fn(async () => ({ members: [] })),
    updateMember: vi.fn(async () => { throw new Error("unused"); }),
    listInvites: vi.fn(async () => ({ invites: [], ttlDays: 7 })),
    createInvite: vi.fn(async () => { throw new Error("unused"); }),
    revokeInvite: vi.fn(async () => undefined),
    listWorkspaceGrants: vi.fn(async () => ({ grants: [] })),
    createWorkspaceGrant: vi.fn(async () => { throw new Error("unused"); }),
    revokeWorkspaceGrant: vi.fn(async () => undefined),
    listFolders: vi.fn(async () => ({ folders: [] })),
    createFolder: vi.fn(async () => { throw new Error("unused"); }),
    deleteFolder: vi.fn(async () => undefined),
    createFolderGrant: vi.fn(async () => { throw new Error("unused"); }),
    revokeFolderGrant: vi.fn(async () => undefined),
    listFolderObjects: vi.fn(async () => ({ objects: [], cursor: null, truncated: false })),
    downloadFolderObject: vi.fn(async () => new Blob()),
    uploadFolderObject: vi.fn(async () => undefined),
    listWorkspaceFolders: vi.fn(async () => ({ folders: [] })),
    attachFolder: vi.fn(async () => { throw new Error("unused"); }),
    detachFolder: vi.fn(async () => undefined),
    renameFolder: vi.fn(async () => undefined),
    setFolderOrgRole: async () => undefined,
    listAgentRules: async () => ({ rules: [] }),
    putAgentRule: async () => { throw new Error('unused'); },
    deleteAgentRule: async () => undefined,
    listWorkspaceTemplates: async () => ({ templates: [] }),
    createWorkspaceTemplate: async () => { throw new Error('unused'); },
    updateWorkspaceTemplate: async () => { throw new Error('unused'); },
    deleteWorkspaceTemplate: async () => undefined,
    listRecipes: async () => ({ recipes: [] }),
    getRecipe: async () => { throw new Error("unused"); },
    createRecipe: async () => { throw new Error("unused"); },
    updateRecipe: async () => { throw new Error("unused"); },
    deleteRecipe: async () => undefined,
    launchRecipe: async () => ({ workspace: workspace("creating", "poll") }),
    getUsageCapture: async () => ({ enabled: false, folderId: null }),
    putUsageCapture: async (enabled: boolean) => ({ enabled, folderId: null }),
    setWorkspaceOrgRole: async () => undefined,
    deleteFolderObject: vi.fn(async () => undefined),
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
      organizations: [{
        membership: { id: "membership-one", role: "admin" as const, status: "active" as const },
        org: { id: "org-one", slug: "example", name: "Example", vmLimit: 10 },
      }],
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
    listConnections: vi.fn(async () => ({ connections: [] })),
    putConnection: vi.fn(async () => undefined),
    deleteConnection: vi.fn(async () => undefined),
    listLeases: vi.fn(async () => ({ leases: [] })),
    listCredentialEvents: vi.fn(async () => ({ events: [] })),
    mintWorkspaceConnection: vi.fn(async () => { throw new Error("unused"); }),
    revokeLease: vi.fn(async () => undefined),
    listCredentialRequests: vi.fn(async () => ({ requests: [] })),
    approveCredentialRequest: vi.fn(async () => undefined),
    denyCredentialRequest: vi.fn(async () => undefined),
    listConnectionCatalog: vi.fn(async () => ({ providers: [] })),
    listConnectionGrants: vi.fn(async () => ({ grants: [] })),
    putConnectionGrant: vi.fn(async () => undefined),
    deleteConnectionGrant: vi.fn(async () => undefined),
    listProviderHealth: vi.fn(async () => ({ providers: [] })),
    connectStartUrl: (provider: string) => `/connect/${provider}/start`,
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
