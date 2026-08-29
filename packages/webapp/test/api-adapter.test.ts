import type { WorkspaceView } from "@blitzos/schema";
import { describe, expect, it, vi } from "vitest";
import {
  ApiAdapter,
  workspaceFromWire,
} from "../src/api-adapter.js";
import type { ControlPlaneClient } from "../src/api.js";
import { defaultGlobalWebAppState, defaultWorkspaceWebAppState } from "../src/storage.js";
import { workspaceViewFixture } from "./workspace-fixtures.js";

function workspace(phase: WorkspaceView["phase"], retryAction: WorkspaceView["retryAction"]): WorkspaceView {
  return workspaceViewFixture({
    id: `workspace-${phase}`,
    name: `name-${phase}`,
    machineTypeId: "mv-2c2g@lab",
    phase,
    retryAction,
    canObserve: phase === "ready",
    launchable: phase === "ready",
    revision: 7,
    updatedAt: 1_700_000_005_000,
    error: phase === "error" ? "provider failed" : null,
  });
}

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    getComputeCredential: vi.fn(async () => { throw new Error("unused"); }),
    putComputeCredential: vi.fn(async () => { throw new Error("unused"); }),
    deleteComputeCredential: vi.fn(async () => undefined),
    googleLoginUrl: () => "/auth/google/start",
    inviteGoogleLoginUrl: (code) => `/auth/google/start?invite=${code}`,
    inviteStatus: vi.fn(async () => { throw new Error("unused"); }),
    switchOrg: vi.fn(async () => undefined),
    leaveOrg: vi.fn(async () => undefined),
    listMembers: vi.fn(async () => ({ members: [] })),
    updateMember: vi.fn(async () => { throw new Error("unused"); }),
    listInvites: vi.fn(async () => ({ invites: [], ttlDays: 7 })),
    createInvite: vi.fn(async () => { throw new Error("unused"); }),
    revokeInvite: vi.fn(async () => undefined),
    addWorkspaceMember: vi.fn(async () => { throw new Error("unused"); }),
    updateWorkspaceMember: vi.fn(async () => { throw new Error("unused"); }),
    removeWorkspaceMember: vi.fn(async () => undefined),
    provisionMachine: vi.fn(async () => { throw new Error("unused"); }),
    stopMachine: vi.fn(async () => { throw new Error("unused"); }),
    startMachine: vi.fn(async () => { throw new Error("unused"); }),
    recreateMachine: vi.fn(async () => { throw new Error("unused"); }),
    setMachineType: vi.fn(async () => { throw new Error("unused"); }),
    destroyMachine: vi.fn(async () => { throw new Error("unused"); }),
    listWorkspaceCredentials: vi.fn(async () => ({ credentials: [] })),
    putWorkspaceCredential: vi.fn(async () => undefined),
    revokeWorkspaceCredential: vi.fn(async () => undefined),
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
    orgUsage: async () => ({ seatsUsed: 1, seatLimit: null, vmsUsed: 0, vmLimit: 10, platformCompute: false }),
    billing: async () => { throw new Error('unused'); },
    putUsageCapture: async (enabled: boolean) => ({ enabled, folderId: null }),
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
    listCredentialEvents: vi.fn(async () => ({ events: [] })),
    mintWorkspaceConnection: vi.fn(async () => { throw new Error("unused"); }),
    disconnectWorkspaceConnection: vi.fn(async () => undefined),
    listCredentialRequests: vi.fn(async () => ({ requests: [] })),
    approveCredentialRequest: vi.fn(async () => undefined),
    denyCredentialRequest: vi.fn(async () => undefined),
    listConnectionCatalog: vi.fn(async () => ({ providers: [] })),
    listConnectionGrants: vi.fn(async () => ({ grants: [] })),
    listGithubInstallations: vi.fn(async () => ({ installations: [] })),
    listGithubRepositories: vi.fn(async () => ({
      source: "installations" as const,
      repositories: [],
      truncated: false,
    })),
    checkGithubRepositories: vi.fn(async (repos: string[]) => ({
      results: repos.map((repo) => ({ repo, verdict: "public" as const })),
    })),
    putConnectionGrant: vi.fn(async () => undefined),
    deleteConnectionGrant: vi.fn(async () => undefined),
    listProviderHealth: vi.fn(async () => ({ providers: [] })),
    connectStartUrl: (provider: string) => `/connect/${provider}/start`,
    ...overrides,
  };
}

describe("webapp API adapter", () => {
  it("maps blitz phases and filters terminal phases", () => {
    expect(workspaceFromWire(workspace("ready", null))).toMatchObject({
      status: "running",
      canControl: true,
      // The workspace names its own creator; the viewer's membership id is
      // not an answer to "who owns this".
      ownerMembershipId: "membership-1",
      machineType: "mv-2c2g@lab",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_005_000,
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
