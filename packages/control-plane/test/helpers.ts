import type { CreateVolumeRequest, Volume, WorkspaceView } from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { $Database, teenyHono } from "teenybase/worker";
import { rawDb } from "../src/raw-db.js";
import type { $Env } from "teenybase/worker";
import {
  allowedEmailDomainsFromEnv,
  cloudWorkspaceCredentialPolicyFromEnv,
  controlPlaneOriginFromEnv,
  createSessionPrincipalSource,
  credentialMasterKeyFor,
  installControlPlaneRoutes,
  OrgComputeProviderResolver,
  sessionTtlMsFromEnv,
  signupModeFromEnv,
  VmProviderRegistry,
  WorkspaceWebAppAuth,
  type WorkspaceTunnels,
  type BlobStore,
  type CoreContext,
  type CoreRouter,
  type CoreRuntime,
  type Db,
  type VolumeProviderResolver,
} from "../core/index.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderMachineType,
  VmInspection,
  VmProvider,
  VolumeProvider,
} from "../core/compute/types.js";
import config from "../teenybase.js";
import { hashSecret, randomToken } from "../core/crypto.js";

export const OPERATOR_KEY = "test-operator-key";
export const CRED_MASTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const credentialMasterKey = await credentialMasterKeyFor(CRED_MASTER_KEY);
const webAppAuth = new WorkspaceWebAppAuth("test-webapp-root-secret");
const allowAllRateLimiter: RateLimit = {
  limit: () => Promise.resolve({ success: true }),
};

/** Stands in for the provider OAuth client bindings. Suites that exercise
 * /connect fill it; everything else sees an unconfigured instance. */
export const testConnectSecrets = new Map<string, string>();

interface TestApp {
  request(
    input: RequestInfo | URL,
    init?: RequestInit,
    env?: Record<string, unknown>,
  ): Promise<Response>;
}

type TestBindings = Env & {
  SESSION_TTL_DAYS: string;
  SIGNUP_MODE?: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  ENTITLEMENTS_API_KEY?: string;
  PAYMENT_URL?: string;
  CLOUD_WORKSPACE_CREDENTIAL_POLICY?: string;
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
  /** Which workspace each machine belongs to, for suites that assert on the
   * label rather than the server name. */
  readonly workspaceForMachine = new Map<string, string>();
  createCalls = 0;
  destroyCalls = 0;
  detachCalls = 0;
  onCreate?: (machineId: string) => Promise<void>;
  onDestroy?: (machineId: string) => Promise<void>;
  /** Undefined by default, so the fake places no volume of its own and a
   * suite that never asked for one still sees `volume_id` null. A suite that
   * exercises the auto-created volume sets it. */
  volumeLocation?: (machineTypeId: string) => string | null;

  capabilities() {
    // Ticket-capable from epoch: workspaces created in tests are new.
    return { volumes: true, maxUserDataBytes: 32 * 1024, webAppTicketsSinceMs: 0 };
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
        monthlyPrice: null,
      },
    ];
  }

  async createVm(input: CreateVmInput): Promise<CreatedVm> {
    this.createCalls += 1;
    this.sshPublicKeys.set(input.machineId, input.sshPublicKey);
    this.userData.set(input.machineId, input.userData);
    this.workspaceForMachine.set(input.machineId, input.workspaceId);
    // Also keyed by workspace, so a single-machine suite can ask for the boot
    // script it already has an id for. A multi-member suite asks per machine;
    // this alias would only give it the last one written.
    this.sshPublicKeys.set(input.workspaceId, input.sshPublicKey);
    this.userData.set(input.workspaceId, input.userData);
    await this.onCreate?.(input.machineId);
    return { id: `vm-${input.machineId}`, host: "203.0.113.10", port: 22, user: "blitz" };
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
  workspaceTunnels?: WorkspaceTunnels,
  computeProviderResolver?: OrgComputeProviderResolver,
  volumeProviderResolver?: VolumeProviderResolver,
): TestApp {
  const app = teenyHono<TestEnv>(
    async (context) => {
      context.set("$credentialMasterKey", credentialMasterKey);
      return new $Database(context, config, context.env.DB, context.env.BOX_IMAGES);
    },
    undefined,
    { cors: false, logger: false },
  ) as TestApp;
  const runtimeFor = (context: CoreContext): CoreRuntime => {
    const db = context.get("$db") as Db;
    const bindings = context.env as TestBindings;
    const cloudWorkspaceCredentialPolicy = cloudWorkspaceCredentialPolicyFromEnv(
      bindings.CLOUD_WORKSPACE_CREDENTIAL_POLICY,
    );
    const compute = computeProviderResolver
      ?? new OrgComputeProviderResolver(db, credentialMasterKey, {}, {
        workspaceCredentialPolicy: cloudWorkspaceCredentialPolicy,
      });
    return {
      db,
      blobs: (context.env as TestBindings).BOX_IMAGES as BlobStore,
      fileObjects: (context.env as TestBindings).BOX_IMAGES,
      credentialMasterKey: context.get("$credentialMasterKey") as CryptoKey,
      vars: {
        boxImageRef: (context.env as TestBindings).BOX_IMAGE_REF,
        boxImageSha256: (context.env as TestBindings).BOX_IMAGE_SHA256,
        boxImageTag: (context.env as TestBindings).BOX_IMAGE_TAG,
        sessionTtlMs: sessionTtlMsFromEnv(
          (context.env as TestBindings).SESSION_TTL_DAYS ?? env.SESSION_TTL_DAYS,
        ),
        requestRateLimiter: (context.env as TestBindings).REQUEST_RATE_LIMITER,
        googleClientId: "test-google-client-id",
        googleClientSecret: "test-google-client-secret",
        bootstrapSecret: (context.env as TestBindings).OPERATOR_API_KEY ?? OPERATOR_KEY,
        cloudWorkspaceCredentialPolicy,
        controlPlaneOrigin: controlPlaneOriginFromEnv((context.env as TestBindings).APP_URL),
        connectSecret: (name) => testConnectSecrets.get(name),
        signupMode: signupModeFromEnv((context.env as TestBindings).SIGNUP_MODE),
        allowedEmailDomains: allowedEmailDomainsFromEnv(
          (context.env as TestBindings).ALLOWED_EMAIL_DOMAINS,
        ),
        entitlementsApiKey: (context.env as TestBindings).ENTITLEMENTS_API_KEY,
        paymentUrl: (context.env as TestBindings).PAYMENT_URL,
      },
      providers: {
        vmRegistry: new VmProviderRegistry(
          vmProviders,
          computeProviderResolver === undefined
            ? undefined
            : async (provider, orgId, requiredSource) => compute.handles(provider.id)
              ? compute.resolve(provider.id, orgId, requiredSource)
              : null,
        ),
        volume: volumeProviderResolver ?? {
          forOrg: async () => ({ provider: volumeProvider, credentialSource: null }),
        },
        compute,
        workspaceTunnels,
        webAppAuth,
      },
      principalSource: createSessionPrincipalSource(),
      assets: {
        fetch: async () => new Response("<!doctype html><title>webapp shell</title>", {
          headers: { "Content-Type": "text/html" },
        }),
      },
      waitUntil: (promise) => context.executionCtx.waitUntil(promise),
      reportError: () => undefined,
    };
  };
  installControlPlaneRoutes(app as unknown as CoreRouter, runtimeFor);
  return app;
}

export function harness() {
  const providers = new FakeProviders();
  const app = appWithProviders(providers, providers);
  return { app, providers };
}

export function testRuntime(
  providers: FakeProviders,
  workspaceTunnels?: WorkspaceTunnels,
): CoreRuntime {
  const db = rawDb(env.DB);
  const cloudWorkspaceCredentialPolicy = cloudWorkspaceCredentialPolicyFromEnv(
    (env as TestBindings).CLOUD_WORKSPACE_CREDENTIAL_POLICY,
  );
  const compute = new OrgComputeProviderResolver(db, credentialMasterKey, {}, {
    workspaceCredentialPolicy: cloudWorkspaceCredentialPolicy,
  });
  return {
    db,
    blobs: env.BOX_IMAGES as BlobStore,
    fileObjects: env.BOX_IMAGES,
    credentialMasterKey,
    vars: {
      boxImageRef: env.BOX_IMAGE_REF,
      boxImageSha256: env.BOX_IMAGE_SHA256,
      boxImageTag: env.BOX_IMAGE_TAG,
      sessionTtlMs: sessionTtlMsFromEnv(env.SESSION_TTL_DAYS),
      googleClientId: "test-google-client-id",
      googleClientSecret: "test-google-client-secret",
      bootstrapSecret: OPERATOR_KEY,
      cloudWorkspaceCredentialPolicy,
      connectSecret: (name) => testConnectSecrets.get(name),
    },
    providers: {
      vmRegistry: new VmProviderRegistry([providers]),
      volume: {
        forOrg: async () => ({ provider: providers, credentialSource: null }),
      },
      compute,
      workspaceTunnels,
      webAppAuth,
    },
    principalSource: createSessionPrincipalSource(),
    waitUntil: () => undefined,
    reportError: () => undefined,
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
    SESSION_TTL_DAYS: env.SESSION_TTL_DAYS,
    REQUEST_RATE_LIMITER: allowAllRateLimiter,
    DB: env.DB,
    CRED_MASTER_KEY,
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    OPERATOR_API_KEY: OPERATOR_KEY,
    ...bindings,
  });
}

export async function operatorSession(app?: TestApp): Promise<string> {
  void app;
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO principals (id, unix_name, harnesses)
       VALUES ('operator', 'operator', '["claude","codex"]')`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users
       (id, google_user_id, email, name, avatar_url, platform_operator, created_at, updated_at)
       VALUES ('operator', 'google-operator', 'operator@example.com', 'Operator', NULL, 1, ?1, ?1)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO orgs
       (id, slug, name, vm_limit, created_at, updated_at)
       VALUES ('personal', 'personal', 'Personal', 10, ?1, ?1)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO memberships (id, user_id, org_id, role, status)
       VALUES ('personal', 'operator', 'personal', 'admin', 'active')`,
    ),
    env.DB.prepare(
      `INSERT INTO sessions
       (token_hash, principal_id, created_at, expires_at, membership_id)
       VALUES (?1, 'operator', ?2, ?3, 'personal')`,
    ).bind(await hashSecret(token), now, now + 30 * 24 * 60 * 60 * 1_000),
  ]);
  return `blitz_session=${token}`;
}

export interface OrgMemberSession {
  cookie: string;
  membershipId: string;
}

/** A second identity inside the operator's org. Four suites had grown their
 * own copy of this with three different return shapes, which is how a caller
 * ends up reading `.cookie` off a plain string and debugging a 401. */
export async function sameOrgSession(
  id: string,
  role: "admin" | "member" = "member",
  status: "active" | "disabled" = "active",
): Promise<OrgMemberSession> {
  const token = randomToken();
  const membershipId = `${id}-membership`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO principals (id, unix_name, harnesses) VALUES (?1, 'blitz', '[\"codex\"]')",
    ).bind(id),
    env.DB.prepare(
      `INSERT INTO users
       (id, google_user_id, email, name, avatar_url, platform_operator, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, 0, ?5, ?5)`,
    ).bind(id, `google-${id}`, `${id}@example.com`, id, now),
    env.DB.prepare(
      `INSERT INTO memberships (id, user_id, org_id, role, status)
       VALUES (?1, ?2, 'personal', ?3, ?4)`,
    ).bind(membershipId, id, role, status),
    env.DB.prepare(
      `INSERT INTO sessions
       (token_hash, principal_id, created_at, expires_at, membership_id)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(await hashSecret(token), id, now, now + 60_000, membershipId),
  ]);
  return { cookie: `blitz_session=${token}`, membershipId };
}

export async function userSession(id: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  const orgId = `${id}-org`;
  const membershipId = `${id}-membership`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO principals (id, unix_name, harnesses) VALUES (?1, ?1, '["codex"]')`,
    ).bind(id),
    env.DB.prepare(
      `INSERT INTO users
       (id, google_user_id, email, name, avatar_url, platform_operator, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?1, NULL, 0, ?4, ?4)`,
    ).bind(id, `google-${id}`, `${id}@example.com`, now),
    env.DB.prepare(
      `INSERT INTO orgs (id, slug, name, vm_limit, created_at, updated_at)
       VALUES (?1, ?1, ?1, 10, ?2, ?2)`,
    ).bind(orgId, now),
    env.DB.prepare(
      `INSERT INTO memberships (id, user_id, org_id, role, status)
       VALUES (?1, ?2, ?3, 'admin', 'active')`,
    ).bind(membershipId, id, orgId),
    env.DB.prepare(
      `INSERT INTO sessions
       (token_hash, principal_id, created_at, expires_at, membership_id)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(await hashSecret(token), id, now, now + 30 * 24 * 60 * 60 * 1_000, membershipId),
  ]);
  return `blitz_session=${token}`;
}

interface CreatedWorkspace {
  workspace: WorkspaceView;
}

export async function createWorkspace(
  app: TestApp,
  cookie: string,
  volumeId?: string,
): Promise<WorkspaceView> {
  const body: Record<string, unknown> = {
    machineTypeId: "small",
    sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
  };
  if (volumeId !== undefined) body.volumeId = volumeId;
  const response = await appRequest(app, "/workspaces", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const created = await response.json<CreatedWorkspace>();
  return created.workspace;
}

/** The creator's machine in a workspace. Most suites hold a workspace id and
 * want the one VM behind it; a multi-member suite asks for a membership. */
export async function machineIdFor(
  workspaceId: string,
  membershipId = "personal",
): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT id FROM machines WHERE workspace_id = ?1 AND membership_id = ?2 LIMIT 1",
  ).bind(workspaceId, membershipId).first<{ id: string }>();
  if (row === null) throw new Error(`no machine for workspace ${workspaceId}`);
  return row.id;
}

/** The machine's own phone-home URL, resolved from the workspace id most
 * suites carry. */
export async function workspacePhoneHomeUrl(
  providers: FakeProviders,
  workspaceId: string,
  membershipId = "personal",
): Promise<string> {
  return phoneHomeUrl(providers, await machineIdFor(workspaceId, membershipId));
}

/** The phone-home URL baked into one boot script. The fake provider records
 * user data under the machine id and under the workspace id, so a suite with
 * one machine per workspace can pass either. */
export function phoneHomeUrl(providers: FakeProviders, id: string): string {
  const data = providers.userData.get(id);
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

/** Boots a workspace's first machine far enough to hold a guest access token,
 * which is the only identity the `/workspaces/self/*` routes accept. */
export async function boxTokenFor(
  app: TestApp,
  providers: FakeProviders,
  workspaceId: string,
): Promise<string> {
  const ready = await appRequest(app, new URL(phoneHomeUrl(providers, workspaceId)).pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pub_key_ed25519: "ssh-ed25519 AAAAhost" }),
  });
  return (await ready.json<{ access_token: string }>()).access_token;
}

export async function resetDatabase(): Promise<void> {
  // Ordered children-first because D1 enforces foreign keys: machines sit
  // between workspaces and everything keyed on a guest (token families,
  // broker keys, leases), and recipes stamp workspaces.recipe_id.
  const tables = [
    "microvm_hosts",
    "provider_health",
    "workspace_repos",
    "session_shares",
    "folder_grants",
    "folder_attachments",
    "folders",
    "credential_events",
    "credential_requests",
    "credential_leases",
    "workspace_credentials",
    "workspace_members",
    "volume_ownership",
    "user_oauth_grants",
    "connections",
    "broker_keys",
    "broker_members",
    "broker_boxes",
    "machine_token_families",
    "box_token_families",
    "machines",
    "boxes",
    "device_authorizations",
    "workspace_member_views",
    "workspace_sessions",
    "webapp_state",
    "workspaces",
    "recipes",
    "agent_rules",
    "operator_tokens",
    "sessions",
    "invites",
    "memberships",
    "org_entitlements",
    "orgs",
    "users",
    "principals",
  ];
  // workspaces and recipes point at each other — a workspace stamps the
  // recipe that launched it, and a recipe names the workspace it clones — so
  // both pointers are cleared before either table is emptied.
  await env.DB.batch([
    env.DB.prepare("UPDATE workspaces SET recipe_id = NULL"),
    env.DB.prepare("UPDATE recipes SET source_workspace_id = NULL"),
    ...tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  ]);
}
