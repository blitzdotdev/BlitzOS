import type {
  CreateWorkspaceRequest,
  ListMachineTypesResponse,
  RetryAction,
  Volume,
  WorkspaceView,
} from "@blitzos/schema";
import {
  ApiRequestError,
  type ControlPlaneClient,
  type MeResponse,
} from "./api.js";
import type {
  GlobalWebAppStateV1,
  WebAppStateResponse,
  WorkspaceWebAppStateV1,
} from "./storage.js";
import type {
  IdentityRecord,
  MembershipRecord,
  OrgRecord,
  RestWorkspaceStatus,
  WorkspaceRecord,
} from "./protocol.js";

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly retryAction: RetryAction = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type TenantMe = {
  identity: IdentityRecord;
  membership: MembershipRecord;
  org: OrgRecord;
  organizations: Array<{ membership: MembershipRecord; org: OrgRecord }>;
};

export type Me = {
  identity: IdentityRecord;
  membership: MembershipRecord | null;
  org: OrgRecord | null;
  organizations: Array<{ membership: MembershipRecord; org: OrgRecord }>;
};

export type V2WorkspaceRecord = WorkspaceRecord & {
  ingressLabel: string;
  sessionUrl: null;
  retryAction: RetryAction;
  wire: WorkspaceView;
};

type WebAppWireClient = Pick<
  ControlPlaneClient,
  | "googleLoginUrl"
  | "logout"
  | "me"
  | "createOrg"
  | "getGlobalWebAppState"
  | "putGlobalWebAppState"
  | "getWorkspaceWebAppState"
  | "putWorkspaceWebAppState"
  | "poll"
  | "create"
  | "destroy"
  | "launchRecipe"
  | "listMachineTypes"
  | "listVolumes"
>;

export function isTenantMe(viewer: Me): viewer is TenantMe {
  return viewer.membership !== null && viewer.org !== null;
}

function meFromWire(me: MeResponse): Me {
  return {
    identity: {
      id: me.user.id,
      email: me.user.email,
      name: me.user.name,
      avatarUrl: me.user.avatarUrl,
      platformOperator: me.user.platformOperator,
    },
    membership: me.membership === null
      ? null
      : { id: me.membership.id, role: me.membership.role },
    org: me.org === null
      ? null
      : { id: me.org.id, slug: me.org.slug, name: me.org.name, vmLimit: me.org.vmLimit },
    organizations: me.organizations.map((item) => ({
      membership: { id: item.membership.id, role: item.membership.role },
      org: {
        id: item.org.id,
        slug: item.org.slug,
        name: item.org.name,
        vmLimit: item.org.vmLimit,
      },
    })),
  };
}

function statusFromWire(workspace: WorkspaceView): RestWorkspaceStatus {
  if (workspace.phase === "ready") return "running";
  if (workspace.phase === "creating") return "creating";
  if (workspace.phase === "error") return "error";
  return workspace.phase;
}

export function workspaceFromWire(workspace: WorkspaceView): V2WorkspaceRecord | null {
  if (workspace.phase === "destroying" || workspace.phase === "destroyed") return null;
  return {
    id: workspace.id,
    // The workspace names its creator, so this no longer has to be inferred
    // from "the viewer is the owner" — which could only ever name the viewer.
    ownerMembershipId: workspace.ownerMembershipId ?? "",
    canControl: workspace.role !== null,
    shared: workspace.role === "editor" || workspace.role === "viewer",
    accessRole: workspace.role,
    owner: workspace.owner,
    machineType: workspace.machineTypeId,
    volumeId: workspace.volumeId,
    name: workspace.name,
    status: statusFromWire(workspace),
    errorDetail: workspace.error,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    connections: workspace.connections,
    members: workspace.members,
    credentials: workspace.credentials,
    defaultMachineTypeId: workspace.defaultMachineTypeId,
    autoProvision: workspace.autoProvision,
    agentRuleId: workspace.agentRuleId,
    myRole: workspace.myRole,
    ingressLabel: workspace.id,
    sessionUrl: null,
    retryAction: workspace.retryAction,
    wire: workspace,
  };
}

export class ApiAdapter {
  public constructor(
    private readonly client: WebAppWireClient,
    private readonly onUnauthorized: () => void,
  ) {}

  public googleLoginUrl(): string {
    return this.client.googleLoginUrl();
  }

  public async logout(): Promise<void> {
    await this.call(() => this.client.logout());
  }

  public async getMe(): Promise<Me> {
    return meFromWire(await this.call(() => this.client.me()));
  }

  public async createOrg(name: string): Promise<void> {
    await this.call(() => this.client.createOrg(name));
  }

  public async listWorkspaces(): Promise<V2WorkspaceRecord[]> {
    const wire = (await this.call(() => this.client.poll())).workspaces;
    return wire.flatMap((workspace) => {
      const mapped = workspaceFromWire(workspace);
      return mapped === null ? [] : [mapped];
    });
  }

  public async createWorkspace(input: CreateWorkspaceRequest): Promise<V2WorkspaceRecord> {
    const response = await this.call(() => this.client.create(input));
    const mapped = workspaceFromWire(response.workspace);
    if (mapped === null) throw new ApiError("The created workspace is no longer available.", 409);
    return mapped;
  }

  public async deleteWorkspace(id: string): Promise<void> {
    await this.call(() => this.client.destroy(id));
  }

  /** A recipe launch answers with the create-workspace envelope, so it maps
   * through the same wire adapter and rides the same navigation flow. */
  public async launchRecipe(recipeId: string): Promise<V2WorkspaceRecord> {
    const response = await this.call(() => this.client.launchRecipe(recipeId));
    const mapped = workspaceFromWire(response.workspace);
    if (mapped === null) throw new ApiError("The launched workspace is no longer available.", 409);
    return mapped;
  }

  public listMachineTypes(): Promise<ListMachineTypesResponse> {
    return this.call(() => this.client.listMachineTypes());
  }

  public async listVolumes(): Promise<Volume[]> {
    return (await this.call(() => this.client.listVolumes())).volumes;
  }

  public getGlobalWebAppState(): Promise<WebAppStateResponse<GlobalWebAppStateV1>> {
    return this.call(() => this.client.getGlobalWebAppState());
  }

  public putGlobalWebAppState(
    doc: GlobalWebAppStateV1,
  ): Promise<WebAppStateResponse<GlobalWebAppStateV1>> {
    return this.call(() => this.client.putGlobalWebAppState(doc));
  }

  public getWorkspaceWebAppState(
    workspaceId: string,
  ): Promise<WebAppStateResponse<WorkspaceWebAppStateV1>> {
    return this.call(() => this.client.getWorkspaceWebAppState(workspaceId));
  }

  public putWorkspaceWebAppState(
    workspaceId: string,
    doc: WorkspaceWebAppStateV1,
  ): Promise<WebAppStateResponse<WorkspaceWebAppStateV1>> {
    return this.call(() => this.client.putWorkspaceWebAppState(workspaceId, doc));
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        if (caught.status === 401) this.onUnauthorized();
        throw new ApiError(caught.message, caught.status, caught.retryAction);
      }
      throw caught;
    }
  }
}
