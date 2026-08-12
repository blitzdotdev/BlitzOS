import type {
  CreateVolumeRequest,
  MachineType,
  Volume,
  WorkspaceView,
} from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { createApp } from "../src/app.js";
import { createOperatorPrincipalSource } from "../src/principals.js";
import type {
  CreatedVm,
  CreateVmInput,
  VmInspection,
  VmProvider,
  VolumeProvider,
} from "../src/providers/types.js";

export const OPERATOR_KEY = "test-operator-key";

export class FakeProviders implements VmProvider, VolumeProvider {
  readonly userData = new Map<string, string>();
  readonly volumes = new Map<string, Volume>();
  destroyCalls = 0;
  detachCalls = 0;
  onCreate?: (workspaceId: string) => Promise<void>;
  onDestroy?: (workspaceId: string) => Promise<void>;

  capabilities() {
    return { volumes: true };
  }

  async listMachineTypes(): Promise<MachineType[]> {
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
    this.userData.set(input.workspaceId, input.userData);
    await this.onCreate?.(input.workspaceId);
    return { id: `vm-${input.workspaceId}`, host: "203.0.113.10", port: 22, user: "blitz" };
  }

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

export function harness() {
  const providers = new FakeProviders();
  const app = createApp({
    vmProvider: providers,
    volumeProvider: providers,
    principalSource: createOperatorPrincipalSource(OPERATOR_KEY),
  });
  return { app, providers };
}

export async function appRequest(
  app: ReturnType<typeof createApp>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return app.request(`https://cp.example${path}`, init, { DB: env.DB });
}

export async function operatorSession(app: ReturnType<typeof createApp>): Promise<string> {
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
  app: ReturnType<typeof createApp>,
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
  const match = data?.match(/url: "([^"]+)"/u);
  if (match?.[1] === undefined) throw new Error("phone_home URL not found");
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
  app: ReturnType<typeof createApp>,
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
