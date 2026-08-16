import type { CreateVolumeRequest, Volume, WorkspaceView } from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { $Database, $DatabaseRawImpl, teenyHono } from "teenybase/worker";
import type { $Env } from "teenybase/worker";
import {
  createOperatorPrincipalSource,
  credentialMasterKeyFor,
  installControlPlaneRoutes,
  maxConcurrentWorkspacesFromEnv,
  sessionTtlMsFromEnv,
  VmProviderRegistry,
  type BlobStore,
  type CoreContext,
  type CoreRouter,
  type CoreRuntime,
  type Db,
} from "../core/index.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderMachineType,
  VmInspection,
  VmProvider,
  VolumeProvider,
} from "../core/providers/types.js";
import config from "../teenybase.js";

export const OPERATOR_KEY = "test-operator-key";
export const CRED_MASTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const credentialMasterKey = await credentialMasterKeyFor(CRED_MASTER_KEY);

interface TestApp {
  request(
    input: RequestInfo | URL,
    init?: RequestInit,
    env?: Record<string, unknown>,
  ): Promise<Response>;
}

type TestBindings = Env & {
  JWT_SECRET_MAIN?: string;
  SESSION_TTL_DAYS?: string;
  MAX_CONCURRENT_WORKSPACES?: string;
  CRED_MASTER_KEY: string;
  RESPOND_WITH_ERRORS: string | boolean;
  RESPOND_WITH_QUERY_LOG: string | boolean;
};

type TestEnv = $Env<TestBindings> & {
  Variables: $Env<TestBindings>["Variables"] & {
    $credentialMasterKey: CryptoKey;
  };
};

export class FakeProviders implements VmProvider, VolumeProvider {
  readonly id = "fake";
  readonly sshPublicKeys = new Map<string, string | undefined>();
  readonly userData = new Map<string, string>();
  readonly volumes = new Map<string, Volume>();
  createCalls = 0;
  destroyCalls = 0;
  detachCalls = 0;
  onCreate?: (workspaceId: string) => Promise<void>;
  onDestroy?: (workspaceId: string) => Promise<void>;

  capabilities() {
    return { volumes: true, maxUserDataBytes: 32 * 1024 };
  }

  ownsMachineType(machineTypeId: string): boolean {
    return machineTypeId === "small";
  }

  ownsVmId(vmId: string): boolean {
    return vmId.startsWith("vm-");
  }

  async listMachineTypes(): Promise<ProviderMachineType[]> {
    return [
      {
        id: "small",
        name: "Small",
        cpuCores: 2,
        memGb: 4,
        diskGb: 40,
        arch: "x86",
        location: "test",
      },
    ];
  }

  async createVm(input: CreateVmInput): Promise<CreatedVm> {
    this.createCalls += 1;
    this.sshPublicKeys.set(input.workspaceId, input.sshPublicKey);
    this.userData.set(input.workspaceId, input.userData);
    await this.onCreate?.(input.workspaceId);
    return { id: `vm-${input.workspaceId}`, host: "203.0.113.10", port: 22, user: "blitz" };
  }

  async shutdown(_id: string): Promise<void> {}

  async destroy(id: string): Promise<void> {
    this.destroyCalls += 1;
    await this.onDestroy?.(id.slice("vm-".length));
  }

  async inspect(id: string): Promise<VmInspection | null> {
    return {
      id,
      host: "203.0.113.10",
      port: 22,
      user: "blitz",
      state: "running",
    };
  }

  async createVolume(input: CreateVolumeRequest): Promise<Volume> {
    const volume: Volume = {
      id: `volume-${this.volumes.size + 1}`,
      name: input.name,
      sizeGb: input.sizeGb,
      location: input.location,
      status: "available",
      attachedTo: null,
    };
    this.volumes.set(volume.id, volume);
    return volume;
  }

  async attachVolume(volumeId: string, vmId: string): Promise<void> {
    const volume = this.volumes.get(volumeId);
    if (volume !== undefined) {
      this.volumes.set(volumeId, { ...volume, status: "attached", attachedTo: vmId });
    }
  }

  async detachVolume(volumeId: string, _vmId: string): Promise<void> {
    this.detachCalls += 1;
    const volume = this.volumes.get(volumeId);
    if (volume !== undefined) {
      this.volumes.set(volumeId, { ...volume, status: "available", attachedTo: null });
    }
  }

  async deleteVolume(id: string): Promise<void> {
    this.volumes.delete(id);
  }

  async listVolumes(): Promise<Volume[]> {
    return [...this.volumes.values()];
  }
}

export function appWithProviders(
  vmProvider: VmProvider,
  volumeProvider: VolumeProvider,
): TestApp {
  return appWithVmProviders([vmProvider], volumeProvider);
}

export function appWithVmProviders(
  vmProviders: readonly VmProvider[],
  volumeProvider: VolumeProvider,
): TestApp {
  const app = teenyHono<TestEnv>(
    async (context) => {
      context.set("$credentialMasterKey", credentialMasterKey);
      return new $Database(context, config, context.env.DB, context.env.BOX_IMAGES);
    },
    undefined,
    { cors: false, logger: false },
  ) as TestApp;
  const runtimeFor = (context: CoreContext): CoreRuntime => ({
    db: context.get("$db") as Db,
    blobs: (context.env as TestBindings).BOX_IMAGES as BlobStore,
    credentialMasterKey: context.get("$credentialMasterKey") as CryptoKey,
    vars: {
      boxImageRef: (context.env as TestBindings).BOX_IMAGE_REF,
      boxImageSha256: (context.env as TestBindings).BOX_IMAGE_SHA256,
      boxImageTag: (context.env as TestBindings).BOX_IMAGE_TAG,
      sessionTtlMs: sessionTtlMsFromEnv(
        (context.env as TestBindings).SESSION_TTL_DAYS,
      ),
      maxConcurrentWorkspaces: maxConcurrentWorkspacesFromEnv(
        (context.env as TestBindings).MAX_CONCURRENT_WORKSPACES,
      ),
    },
    providers: {
      vmRegistry: new VmProviderRegistry(vmProviders),
      volume: volumeProvider,
    },
    principalSource: createOperatorPrincipalSource(OPERATOR_KEY),
    waitUntil: (promise) => context.executionCtx.waitUntil(promise),
  });
  installControlPlaneRoutes(app as unknown as CoreRouter, runtimeFor);
  return app;
}

export function harness() {
  const providers = new FakeProviders();
  const app = appWithProviders(providers, providers);
  return { app, providers };
}

export function testRuntime(providers: FakeProviders): CoreRuntime {
  return {
    db: new $DatabaseRawImpl(env.DB),
    blobs: env.BOX_IMAGES as BlobStore,
    credentialMasterKey,
    vars: {
      boxImageRef: env.BOX_IMAGE_REF,
      boxImageSha256: env.BOX_IMAGE_SHA256,
      boxImageTag: env.BOX_IMAGE_TAG,
      sessionTtlMs: sessionTtlMsFromEnv(undefined),
      maxConcurrentWorkspaces: maxConcurrentWorkspacesFromEnv(undefined),
    },
    providers: {
      vmRegistry: new VmProviderRegistry([providers]),
      volume: providers,
    },
    principalSource: createOperatorPrincipalSource(OPERATOR_KEY),
    waitUntil: () => undefined,
  };
}

export async function appRequest(
  app: TestApp,
  path: string,
  init?: RequestInit,
  bindings: Record<string, unknown> = {},
): Promise<Response> {
  return app.request(`https://cp.example${path}`, init, {
    BOX_IMAGES: env.BOX_IMAGES,
    BOX_IMAGE_REF: env.BOX_IMAGE_REF,
    BOX_IMAGE_SHA256: env.BOX_IMAGE_SHA256,
    BOX_IMAGE_TAG: env.BOX_IMAGE_TAG,
    DB: env.DB,
    CRED_MASTER_KEY,
    ...bindings,
  });
}

export async function operatorSession(app: TestApp): Promise<string> {
  const response = await appRequest(app, "/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR_KEY}` },
  });
  if (response.status !== 204) throw new Error("operator session exchange failed");
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("operator session cookie is missing");
  return cookie;
}

interface CreatedWorkspace {
  workspace: WorkspaceView;
}

export async function createWorkspace(
  app: TestApp,
  cookie: string,
  volumeId?: string,
): Promise<WorkspaceView> {
  const response = await appRequest(app, "/workspaces", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      machineTypeId: "small",
      sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
      ...(volumeId === undefined ? {} : { volumeId }),
    }),
  });
  const body = await response.json<CreatedWorkspace>();
  return body.workspace;
}

export function phoneHomeUrl(providers: FakeProviders, workspaceId: string): string {
  const data = providers.userData.get(workspaceId);
  const match = data?.match(/readonly PHONE_HOME_URL='([^']+)'/u);
  if (match?.[1] === undefined) throw new Error("phone-home URL not found");
  return match[1];
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
}

export interface BoxCredential {
  box_id: string;
  access_token: string;
  refresh_token: string;
}

export async function enrollBox(
  app: TestApp,
  cookie: string,
): Promise<BoxCredential> {
  const authorization = await appRequest(app, "/oauth/device_authorization", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: "blitz-box" }),
  });
  const device = await authorization.json<DeviceAuthorization>();
  const approval = await appRequest(app, "/oauth/device/approve", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ user_code: device.user_code }),
  });
  if (approval.status !== 204) throw new Error("device approval failed");
  const token = await appRequest(app, "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: "blitz-box",
    }),
  });
  if (token.status !== 200) throw new Error("device token exchange failed");
  return token.json<BoxCredential>();
}

export async function resetDatabase(): Promise<void> {
  const tables = [
    "microvm_hosts",
    "credential_events",
    "credential_requests",
    "credential_leases",
    "user_connections",
    "integrations",
    "broker_keys",
    "broker_boxes",
    "box_token_families",
    "boxes",
    "device_authorizations",
    "workspaces",
    "sessions",
    "principals",
  ];
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}
