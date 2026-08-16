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
} from "./api.js";
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
  githubAppSlug: string;
  identity: IdentityRecord;
  membership: MembershipRecord;
  org: OrgRecord;
};

export type Me = TenantMe;

export type V2WorkspaceRecord = WorkspaceRecord & {
  ingressLabel: string;
  sessionUrl: null;
  retryAction: RetryAction;
  wire: WorkspaceView;
};

type WebAppWireClient = Pick<
  ControlPlaneClient,
  | "login"
  | "logout"
  | "poll"
  | "create"
  | "destroy"
  | "listMachineTypes"
  | "listVolumes"
>;

const PERSONAL_ME: TenantMe = {
  githubAppSlug: "",
  identity: {
    githubLogin: "operator",
    name: "Operator",
    avatarUrl: null,
  },
  membership: {
    id: "personal",
    role: "admin",
  },
  org: {
    id: "personal",
    slug: "personal",
    name: "Personal",
  },
};

export function synthesizePersonalMe(): TenantMe {
  return {
    ...PERSONAL_ME,
    identity: { ...PERSONAL_ME.identity },
    membership: { ...PERSONAL_ME.membership },
    org: { ...PERSONAL_ME.org },
  };
}

export function isTenantMe(_viewer: Me): _viewer is TenantMe {
  return true;
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
    ownerMembershipId: "personal",
    canControl: true,
    shared: false,
    machineType: workspace.machineTypeId,
    name: workspace.name,
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
  private bootstrapWorkspaces: WorkspaceView[] | null = null;

  public constructor(
    private readonly client: WebAppWireClient,
    private readonly onUnauthorized: () => void,
  ) {}

  public async login(operatorKey: string): Promise<void> {
    await this.call(() => this.client.login(operatorKey));
    this.bootstrapWorkspaces = null;
  }

  public async logout(): Promise<void> {
    await this.call(() => this.client.logout());
    this.bootstrapWorkspaces = null;
  }

  public async getMe(): Promise<Me> {
    const response = await this.call(() => this.client.poll());
    this.bootstrapWorkspaces = response.workspaces;
    return synthesizePersonalMe();
  }

  public async listWorkspaces(): Promise<V2WorkspaceRecord[]> {
    const wire = this.bootstrapWorkspaces ?? (await this.call(() => this.client.poll())).workspaces;
    this.bootstrapWorkspaces = null;
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

  public async listMachineTypes(): Promise<MachineType[]> {
    return (await this.call(() => this.client.listMachineTypes())).machineTypes;
  }

  public async listVolumes(): Promise<Volume[]> {
    return (await this.call(() => this.client.listVolumes())).volumes;
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
