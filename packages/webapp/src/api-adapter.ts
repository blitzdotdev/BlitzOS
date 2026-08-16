import type {
  CreateWorkspaceRequest,
  MachineType,
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
};

export type Me = {
  identity: IdentityRecord;
  membership: MembershipRecord | null;
  org: OrgRecord | null;
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
  };
}

function statusFromWire(workspace: WorkspaceView): RestWorkspaceStatus {
  if (workspace.phase === "ready") return "running";
  if (workspace.phase === "creating") return "creating";
  if (workspace.phase === "error") return "error";
  return workspace.phase;
}

export function workspaceFromWire(
  workspace: WorkspaceView,
  ownerMembershipId = "",
): V2WorkspaceRecord | null {
  if (workspace.phase === "destroying" || workspace.phase === "destroyed") return null;
  return {
    id: workspace.id,
    ownerMembershipId,
    canControl: true,
    shared: false,
    machineType: workspace.machineTypeId,
    name: workspace.id,
    status: statusFromWire(workspace),
    errorDetail: workspace.error,
    createdAt: 0,
    updatedAt: workspace.revision,
    ingressLabel: workspace.id,
    sessionUrl: null,
    retryAction: workspace.retryAction,
    wire: workspace,
  };
}

export class ApiAdapter {
  private ownerMembershipId = "";

  public constructor(
    private readonly client: WebAppWireClient,
    private readonly onUnauthorized: () => void,
  ) {}

  public googleLoginUrl(): string {
    return this.client.googleLoginUrl();
  }

  public async logout(): Promise<void> {
    await this.call(() => this.client.logout());
    this.ownerMembershipId = "";
  }

  public async getMe(): Promise<Me> {
    const me = meFromWire(await this.call(() => this.client.me()));
    this.ownerMembershipId = me.membership?.id ?? "";
    return me;
  }

  public async createOrg(name: string): Promise<void> {
    await this.call(() => this.client.createOrg(name));
  }

  public async listWorkspaces(): Promise<V2WorkspaceRecord[]> {
    const wire = (await this.call(() => this.client.poll())).workspaces;
    return wire.flatMap((workspace) => {
      const mapped = workspaceFromWire(workspace, this.ownerMembershipId);
      return mapped === null ? [] : [mapped];
    });
  }

  public async createWorkspace(input: CreateWorkspaceRequest): Promise<V2WorkspaceRecord> {
    const response = await this.call(() => this.client.create(input));
    const mapped = workspaceFromWire(response.workspace, this.ownerMembershipId);
    if (mapped === null) throw new ApiError("The created workspace is no longer available.", 409);
    return mapped;
  }

  public async deleteWorkspace(id: string): Promise<void> {
    await this.call(() => this.client.destroy(id));
  }

  public async listMachineTypes(): Promise<MachineType[]> {
    return (await this.call(() => this.client.listMachineTypes())).machineTypes;
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
