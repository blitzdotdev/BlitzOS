import type {
  CredentialLeaseView,
  ListCredentialLeasesResponse,
  ListUserGrantsResponse,
  MintResult,
  WorkspaceConnectionsResponse,
  WorkspaceView,
} from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  enablementManifestJson,
  manifestAllows,
  manifestConnectionNames,
  manifestWithConnection,
  manifestWithoutConnection,
} from "../core/connections/manifest.js";
import {
  appRequest,
  harness,
  operatorSession,
  phoneHomeUrl,
  resetDatabase,
  testConnectSecrets,
  type BoxCredential,
} from "./helpers.js";

const LINEAR_KEY = "lin_api_test-only-personal-key";

type Harness = ReturnType<typeof harness>;

/** The workspace's allow-list, as the box reads it. Only the manifest decides;
 * this is the one query the assertions below need. */
async function storedManifest(workspaceId: string): Promise<string | null> {
  const row = await env.DB
    .prepare("SELECT manifest FROM workspaces WHERE id = ?1")
    .bind(workspaceId)
    .first<{ manifest: string | null }>();
  return row?.manifest ?? null;
}

async function setManifest(workspaceId: string, manifest: string | null): Promise<void> {
  await env.DB
    .prepare("UPDATE workspaces SET manifest = ?1 WHERE id = ?2")
    .bind(manifest, workspaceId)
    .run();
}

async function grantLinear(app: Harness["app"], cookie: string): Promise<void> {
  const stored = await appRequest(app, "/connections/grants/linear", {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ manifestId: "linear", token: LINEAR_KEY }),
  });
  expect(stored.status).toBe(204);
}

interface ReadyWorkspace {
  workspace: WorkspaceView;
  box: BoxCredential;
}

async function readyWorkspace(
  { app, providers }: Harness,
  cookie: string,
  body: Record<string, unknown> = {},
): Promise<ReadyWorkspace> {
  const created = await appRequest(app, "/workspaces", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ machineTypeId: "small", ...body }),
  });
  expect(created.status).toBe(201);
  const { workspace } = await created.json<{ workspace: WorkspaceView }>();
  const callback = new URL(phoneHomeUrl(providers, workspace.id));
  const enrolled = await appRequest(app, callback.pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pub_key_ed25519: "ssh-ed25519 AAAAC3Nzatest host" }),
  });
  expect(enrolled.status).toBe(200);
  return { workspace, box: await enrolled.json<BoxCredential>() };
}

function boxHeaders(box: BoxCredential): Record<string, string> {
  return { Authorization: `Bearer ${box.access_token}` };
}

async function pull(
  app: Harness["app"],
  box: BoxCredential,
  name: string,
): Promise<Response> {
  return appRequest(app, `/workspaces/self/connections/${name}/token`, {
    method: "POST",
    headers: boxHeaders(box),
  });
}

async function boxConnections(
  app: Harness["app"],
  box: BoxCredential,
): Promise<string[]> {
  const response = await appRequest(app, "/workspaces/self/connections", {
    headers: boxHeaders(box),
  });
  expect(response.status).toBe(200);
  const body = await response.json<WorkspaceConnectionsResponse>();
  return body.connections;
}

async function connect(
  app: Harness["app"],
  cookie: string,
  workspaceId: string,
  name: string,
): Promise<Response> {
  return appRequest(app, `/workspaces/${workspaceId}/connections/${name}/lease`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
}

async function disconnect(
  app: Harness["app"],
  cookie: string,
  workspaceId: string,
  name: string,
): Promise<Response> {
  return appRequest(app, `/workspaces/${workspaceId}/connections/${name}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
}

describe("credential manifest: the allow-list decides", () => {
  it("denies everything when the column is NULL", () => {
    // The old default allowed everything. A workspace created before this
    // column existed could therefore mint any provider its owner had ever
    // authorized, in a workspace nobody connected that provider to.
    expect(manifestAllows(null, "linear", [])).toBe(false);
    expect(manifestConnectionNames(null)).toEqual([]);
  });

  it("denies everything when the document is empty", () => {
    const empty = enablementManifestJson(undefined, []);
    expect(empty).toBe('{"integrations":{}}');
    expect(manifestAllows(empty, "linear", [])).toBe(false);
  });

  it("denies everything when the document is unreadable", () => {
    expect(manifestAllows("not json", "linear", [])).toBe(false);
  });

  it("allows a provider the document names", () => {
    const manifest = enablementManifestJson(undefined, ["linear"]);
    expect(manifestAllows(manifest, "linear", [])).toBe(true);
    expect(manifestAllows(manifest, "github", [])).toBe(false);
  });

  it("keeps a scope ceiling when a connect adds the same provider again", () => {
    // A template can stipulate a narrow scope list. A later click means "turn
    // this on here", not "widen what it may reach".
    const narrow = JSON.stringify({ integrations: { linear: { scopes: ["read"] } } });
    const widened = manifestWithConnection(narrow, "linear");
    expect(manifestAllows(widened, "linear", ["read"])).toBe(true);
    expect(manifestAllows(widened, "linear", ["write"])).toBe(false);
  });

  it("builds a document from NULL rather than staying NULL", () => {
    expect(manifestWithConnection(null, "linear")).toBe(
      '{"integrations":{"linear":{}}}',
    );
    expect(manifestWithoutConnection(null, "linear")).toBe('{"integrations":{}}');
  });

  it("removes only the provider named", () => {
    const both = enablementManifestJson(undefined, ["linear", "github"]);
    const left = manifestWithoutConnection(both, "linear");
    expect(manifestAllows(left, "linear", [])).toBe(false);
    expect(manifestAllows(left, "github", [])).toBe(true);
  });
});

describe("pull credentials: box routes", () => {
  beforeEach(async () => {
    await resetDatabase();
    testConnectSecrets.clear();
  });

  it("creates every workspace with an allow-list, empty when nothing was asked for", async () => {
    const context = harness();
    const cookie = await operatorSession();
    const { workspace, box } = await readyWorkspace(context, cookie);
    expect(await storedManifest(workspace.id)).toBe('{"integrations":{}}');
    expect(await boxConnections(context.app, box)).toEqual([]);
  });

  it("refuses a pull the allow-list does not name, and files a request", async () => {
    const context = harness();
    const cookie = await operatorSession();
    await grantLinear(context.app, cookie);
    const { workspace, box } = await readyWorkspace(context, cookie);

    const refused = await pull(context.app, box, "linear");
    expect(refused.status).toBe(403);
    const body = await refused.json<{ error: string; request_id?: string }>();
    expect(body.error).toContain("not connected to linear");
    // The refusal has to be actionable: the id is the row the member answers
    // in the connections panel, and the agent quotes it back to them.
    expect(body.request_id).toBeTypeOf("string");

    const requests = await appRequest(context.app, "/requests?state=pending", {
      headers: { Cookie: cookie },
    });
    const pending = await requests.json<{ requests: { connection_name: string }[] }>();
    expect(pending.requests.map((entry) => entry.connection_name)).toContain("linear");
    void workspace;
  });

  it("refuses a pull when the stored allow-list is NULL", async () => {
    // A workspace row written before the column existed. It must deny, not
    // hand out every provider the owner ever authorized.
    const context = harness();
    const cookie = await operatorSession();
    await grantLinear(context.app, cookie);
    const { workspace, box } = await readyWorkspace(context, cookie, {
      connections: ["linear"],
    });
    await setManifest(workspace.id, null);

    expect((await pull(context.app, box, "linear")).status).toBe(403);
    expect(await boxConnections(context.app, box)).toEqual([]);
  });

  it("mints for a provider the allow-list names", async () => {
    const context = harness();
    const cookie = await operatorSession();
    await grantLinear(context.app, cookie);
    const { box } = await readyWorkspace(context, cookie, { connections: ["linear"] });

    expect(await boxConnections(context.app, box)).toEqual(["linear"]);
    const response = await pull(context.app, box, "linear");
    expect(response.status).toBe(200);
    const result = await response.json<MintResult>();
    expect(result.connection).toBe("linear");
    // Linear is proxy custody, so the box gets a lease token and the pasted
    // key stays in the control plane.
    expect(result.mode).toBe("proxy");
    expect(result.token).not.toBe(LINEAR_KEY);
    expect(result.header).toEqual({ name: "Authorization", prefix: "Bearer " });
    const names = result.env.map((entry) => entry.name);
    expect(names).toContain("LINEAR_API_KEY");
    expect(names).toContain("LINEAR_API_URL");
    const token = result.env.find((entry) => entry.name === "LINEAR_API_KEY");
    expect(token?.value).toBe(result.token);
  });

  it("answers 404 and files a request for a provider nobody declared", async () => {
    const context = harness();
    const cookie = await operatorSession();
    const { box } = await readyWorkspace(context, cookie, { connections: ["notion"] });

    const response = await pull(context.app, box, "notion");
    expect(response.status).toBe(404);
    const body = await response.json<{ request_id?: string }>();
    expect(body.request_id).toBeTypeOf("string");
  });

  it("lets no box read another workspace's allow-list", async () => {
    const context = harness();
    const cookie = await operatorSession();
    await grantLinear(context.app, cookie);
    const mine = await readyWorkspace(context, cookie, { connections: ["linear"] });
    const theirs = await readyWorkspace(context, cookie);

    // The route resolves the workspace from the box token, never from a path
    // parameter, so a box cannot name a workspace it does not own.
    expect(await boxConnections(context.app, mine.box)).toEqual(["linear"]);
    expect(await boxConnections(context.app, theirs.box)).toEqual([]);
  });

  it("rejects a pull with no box token", async () => {
    const context = harness();
    const response = await appRequest(
      context.app,
      "/workspaces/self/connections/linear/token",
      { method: "POST" },
    );
    expect(response.status).toBe(401);
  });
});

describe("pull credentials: connect and disconnect", () => {
  beforeEach(async () => {
    await resetDatabase();
    testConnectSecrets.clear();
  });

  it("adds the provider to this workspace only", async () => {
    const context = harness();
    const cookie = await operatorSession();
    await grantLinear(context.app, cookie);
    const here = await readyWorkspace(context, cookie);
    const elsewhere = await readyWorkspace(context, cookie);

    const connected = await connect(context.app, cookie, here.workspace.id, "linear");
    expect(connected.status).toBe(200);

    expect(await boxConnections(context.app, here.box)).toEqual(["linear"]);
    expect(await boxConnections(context.app, elsewhere.box)).toEqual([]);
    expect((await pull(context.app, here.box, "linear")).status).toBe(200);
    expect((await pull(context.app, elsewhere.box, "linear")).status).toBe(403);
  });

  it("removes the provider from this workspace only, and keeps the grant", async () => {
    const context = harness();
    const cookie = await operatorSession();
    await grantLinear(context.app, cookie);
    const here = await readyWorkspace(context, cookie, { connections: ["linear"] });
    const elsewhere = await readyWorkspace(context, cookie, { connections: ["linear"] });

    expect((await disconnect(context.app, cookie, here.workspace.id, "linear")).status)
      .toBe(204);

    expect(await boxConnections(context.app, here.box)).toEqual([]);
    expect((await pull(context.app, here.box, "linear")).status).toBe(403);

    // The member's authorization is untouched, so every other workspace keeps
    // working and reconnecting here is one click.
    const grants = await appRequest(context.app, "/connections/grants", {
      headers: { Cookie: cookie },
    });
    const { grants: held } = await grants.json<ListUserGrantsResponse>();
    expect(held.map((grant) => grant.provider)).toContain("linear");
    expect((await pull(context.app, elsewhere.box, "linear")).status).toBe(200);
  });

  it("kills this workspace's live lease on disconnect", async () => {
    // A proxy lease token stays usable until its row dies. A capability must
    // not outlive the grant that authorized it.
    const context = harness();
    const cookie = await operatorSession();
    await grantLinear(context.app, cookie);
    const { workspace, box } = await readyWorkspace(context, cookie, {
      connections: ["linear"],
    });
    expect((await pull(context.app, box, "linear")).status).toBe(200);

    await disconnect(context.app, cookie, workspace.id, "linear");

    const leases = await appRequest(context.app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases: rows } = await leases.json<ListCredentialLeasesResponse>();
    const live = rows.filter((lease: CredentialLeaseView) => lease.state === "active");
    expect(live).toEqual([]);
  });

  it("reconnects after a disconnect", async () => {
    const context = harness();
    const cookie = await operatorSession();
    await grantLinear(context.app, cookie);
    const { workspace, box } = await readyWorkspace(context, cookie, {
      connections: ["linear"],
    });

    await disconnect(context.app, cookie, workspace.id, "linear");
    expect((await connect(context.app, cookie, workspace.id, "linear")).status).toBe(200);
    expect((await pull(context.app, box, "linear")).status).toBe(200);
  });

  it("refuses a connect from someone who cannot control the workspace", async () => {
    const context = harness();
    const cookie = await operatorSession();
    await grantLinear(context.app, cookie);
    const { workspace } = await readyWorkspace(context, cookie);

    const stranger = await appRequest(
      context.app,
      `/workspaces/${workspace.id}/connections/linear/lease`,
      { method: "POST" },
    );
    expect(stranger.status).toBe(401);
    expect(await storedManifest(workspace.id)).toBe('{"integrations":{}}');
  });

  it("seeds the allow-list from the connections named at create", async () => {
    const context = harness();
    const cookie = await operatorSession();
    const { workspace, box } = await readyWorkspace(context, cookie, {
      connections: ["github", "linear"],
    });
    expect(manifestConnectionNames(await storedManifest(workspace.id)).sort())
      .toEqual(["github", "linear"]);
    // Sorted, because the box prints one name per line and an unstable order
    // reads as the list changing when nothing changed.
    expect(await boxConnections(context.app, box)).toEqual(["github", "linear"]);
  });
});
