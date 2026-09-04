import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  boxPayloadConfigFromEnv,
  controlPlaneOriginFromEnv,
} from "../core/box-config.js";
import type { BoxConfigResponse } from "../core/wire.js";
import {
  appRequest,
  harness,
  operatorSession,
  phoneHomeUrl,
  resetDatabase,
  sameOrgSession,
  enrollBox,
  type BoxCredential,
} from "./helpers.js";

// Control-plane side of the `box config v1` cross-runtime contract: this
// Worker produces the box-config envelope and consumes the update-result
// report. The host consumer/producer (the updater emitted by
// core/bootstrap.ts) is pinned against the same corpus in
// test/box-update-conformance.test.mjs.

interface ConfigFixture {
  response: Record<string, unknown>;
  accepts: boolean;
}

interface ResultFixture {
  request: Record<string, unknown>;
  accepts: boolean;
}

const fixtureSources = import.meta.glob<string>(
  "../../schema/fixtures/box-config/*.json",
  { eager: true, import: "default", query: "?raw" },
);

function fixtures<Fixture>(prefix: "config-" | "result-"): Array<[string, Fixture]> {
  return Object.entries(fixtureSources)
    .map(([path, source]): [string, string] => [path.slice(path.lastIndexOf("/") + 1), source])
    .filter(([name]) => name.startsWith(prefix))
    // SAFETY: The box-config fixtures are trusted local test data authored to
    // the { response|request, accepts } shape; the host-side conformance test
    // pins the same corpus.
    .map(([name, source]): [string, Fixture] => [name, JSON.parse(source) as Fixture])
    .sort(([left], [right]) => left.localeCompare(right));
}

type Harness = ReturnType<typeof harness>;

interface WorkspaceBox {
  workspaceId: string;
  box: BoxCredential;
}

async function readyWorkspaceBox(
  { app, providers }: Harness,
  cookie: string,
): Promise<WorkspaceBox> {
  const created = await appRequest(app, "/workspaces", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ machineTypeId: "small" }),
  });
  expect(created.status).toBe(201);
  const { workspace } = await created.json<{ workspace: { id: string } }>();
  const callback = new URL(phoneHomeUrl(providers, workspace.id));
  const enrolled = await appRequest(app, callback.pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pub_key_ed25519: "ssh-ed25519 AAAAC3Nzatest host" }),
  });
  expect(enrolled.status).toBe(200);
  return { workspaceId: workspace.id, box: await enrolled.json<BoxCredential>() };
}

function boxHeaders(box: BoxCredential): Record<string, string> {
  return { Authorization: `Bearer ${box.access_token}` };
}

async function workspaceUpdateColumns(
  workspaceId: string,
): Promise<{ box_update_requested: number; box_image_reported: string | null }> {
  const row = await env.DB
    .prepare("SELECT box_update_requested, box_image_reported FROM machines WHERE workspace_id = ?1")
    .bind(workspaceId)
    .first<{ box_update_requested: number; box_image_reported: string | null }>();
  if (row === null) throw new Error("machine row missing");
  return row;
}

describe("box-config control-plane conformance", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("pins the shared box-config fixture corpus", () => {
    expect(fixtures<ConfigFixture>("config-").map(([name]) => name)).toEqual([
      "config-image-ref-with-space.json",
      "config-missing-image-ref.json",
      "config-non-boolean-update-requested.json",
      "config-origin-with-path.json",
      "config-valid-extra-key.json",
      "config-valid-minimal.json",
      "config-valid-payload.json",
      "config-valid-tarball-ref.json",
      "config-valid-update-requested.json",
      "config-valid-versioned-ref.json",
    ]);
    expect(fixtures<ResultFixture>("result-").map(([name]) => name)).toEqual([
      "result-missing-outcome.json",
      "result-missing-ref.json",
      "result-ref-with-space.json",
      "result-unknown-outcome.json",
      "result-valid-extra-key.json",
      "result-valid-rolled-back.json",
      "result-valid-updated.json",
    ]);
  });

  it("answers a workspace box with exactly the accepted envelope shape", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { box } = await readyWorkspaceBox(h, cookie);

    const response = await appRequest(h.app, "/workspaces/self/box-config", {
      headers: boxHeaders(box),
    });

    expect(response.status).toBe(200);
    const body = await response.json<BoxConfigResponse>();
    expect(body).toEqual({
      boxImageRef: env.BOX_IMAGE_REF,
      // No APP_URL binding on this request, so the fallback answers with the
      // origin the poll arrived on.
      controlPlaneOrigin: "https://cp.example",
      updateRequested: false,
      payload: null,
    });
    // The server always emits the additive payload key. The old host parser's
    // tolerance is pinned by the payload fixture on the Python side.
    const payloadFixture = fixtures<ConfigFixture>("config-")
      .find(([name]) => name === "config-valid-payload.json")?.[1];
    if (payloadFixture === undefined) throw new Error("missing payload box-config fixture");
    expect(Object.keys(body).sort()).toEqual(Object.keys(payloadFixture.response).sort());
  });

  it("projects the deployment payload pin without fetching its manifest", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { box } = await readyWorkspaceBox(h, cookie);
    const payloadFixture = fixtures<ConfigFixture>("config-")
      .find(([name]) => name === "config-valid-payload.json")?.[1];
    if (payloadFixture === undefined) throw new Error("missing payload box-config fixture");
    const payload = payloadFixture.response.payload;
    const boxImageRef = payloadFixture.response.boxImageRef;
    if (
      typeof boxImageRef !== "string"
      || payload === null
      || typeof payload !== "object"
      || !("version" in payload)
      || !("manifestUrl" in payload)
    ) {
      throw new Error("payload box-config fixture has no pin");
    }

    const response = await appRequest(
      h.app,
      "/workspaces/self/box-config",
      { headers: boxHeaders(box) },
      {
        BOX_IMAGE_REF: boxImageRef,
        BOX_PAYLOAD_REF: payload.manifestUrl,
        BOX_PAYLOAD_VERSION: payload.version,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json<BoxConfigResponse>()).toEqual(payloadFixture.response);
  });

  it("treats an empty payload ref as off and rejects a malformed active pin", () => {
    expect(boxPayloadConfigFromEnv("", "")).toBeNull();
    expect(() => boxPayloadConfigFromEnv("   ", "stale-version"))
      .toThrow("BOX_PAYLOAD_REF");
    expect(() => boxPayloadConfigFromEnv("not-a-url", "release-1"))
      .toThrow("BOX_PAYLOAD_REF");
    expect(() => boxPayloadConfigFromEnv("https://cp.example/manifest.json", ""))
      .toThrow("BOX_PAYLOAD_VERSION");
  });

  it("serves the configured public origin when APP_URL is set", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { box } = await readyWorkspaceBox(h, cookie);

    const response = await appRequest(
      h.app,
      "/workspaces/self/box-config",
      { headers: boxHeaders(box) },
      { APP_URL: "https://blitzos.example" },
    );

    expect(response.status).toBe(200);
    const body = await response.json<BoxConfigResponse>();
    expect(body.controlPlaneOrigin).toBe("https://blitzos.example");
  });

  it("normalizes APP_URL to an origin and treats unset or invalid as absent", () => {
    expect(controlPlaneOriginFromEnv("https://cp.example/some/path")).toBe("https://cp.example");
    expect(controlPlaneOriginFromEnv("https://cp.example:8443")).toBe("https://cp.example:8443");
    expect(controlPlaneOriginFromEnv("")).toBeUndefined();
    expect(controlPlaneOriginFromEnv("   ")).toBeUndefined();
    expect(controlPlaneOriginFromEnv(undefined)).toBeUndefined();
    expect(controlPlaneOriginFromEnv("not a url")).toBeUndefined();
  });

  it("rejects an unauthenticated read and a box with no workspace", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const deviceBox = await enrollBox(h.app, cookie);

    const anonymous = await appRequest(h.app, "/workspaces/self/box-config");
    const noWorkspace = await appRequest(h.app, "/workspaces/self/box-config", {
      headers: boxHeaders(deviceBox),
    });

    expect(anonymous.status).toBe(401);
    expect(noWorkspace.status).toBe(403);
  });

  it("lets the box request its own update and reflects the flag on the next poll", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { workspaceId, box } = await readyWorkspaceBox(h, cookie);

    const requested = await appRequest(h.app, "/workspaces/self/box-update", {
      method: "POST",
      headers: boxHeaders(box),
    });
    expect(requested.status).toBe(204);
    expect((await workspaceUpdateColumns(workspaceId)).box_update_requested).toBe(1);

    const poll = await appRequest(h.app, "/workspaces/self/box-config", {
      headers: boxHeaders(box),
    });
    expect((await poll.json<BoxConfigResponse>()).updateRequested).toBe(true);
  });

  it("lets a workspace admin hold one machine's payload and resume it", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { box } = await readyWorkspaceBox(h, cookie);
    const payloadBindings = {
      BOX_PAYLOAD_REF: "https://cp.example/box-payload/release-1/manifest.json",
      BOX_PAYLOAD_VERSION: "release-1",
    };

    const before = await appRequest(h.app, "/workspaces/self/box-config", {
      headers: boxHeaders(box),
    }, payloadBindings);
    expect((await before.json<BoxConfigResponse>()).payload).toEqual({
      version: payloadBindings.BOX_PAYLOAD_VERSION,
      manifestUrl: payloadBindings.BOX_PAYLOAD_REF,
    });

    const held = await appRequest(h.app, `/machines/${box.box_id}`, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ payloadHold: true }),
    });
    expect(held.status).toBe(200);
    const heldConfig = await appRequest(h.app, "/workspaces/self/box-config", {
      headers: boxHeaders(box),
    }, payloadBindings);
    expect((await heldConfig.json<BoxConfigResponse>()).payload).toBeNull();

    const stranger = await sameOrgSession("payload-hold-stranger");
    expect((await appRequest(h.app, `/machines/${box.box_id}`, {
      method: "PATCH",
      headers: { Cookie: stranger.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ payloadHold: false }),
    })).status).toBe(403);
    expect((await appRequest(h.app, `/machines/${box.box_id}`, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ payloadHold: "no" }),
    })).status).toBe(400);

    const resumed = await appRequest(h.app, `/machines/${box.box_id}`, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ payloadHold: false }),
    });
    expect(resumed.status).toBe(200);
    const resumedConfig = await appRequest(h.app, "/workspaces/self/box-config", {
      headers: boxHeaders(box),
    }, payloadBindings);
    expect((await resumedConfig.json<BoxConfigResponse>()).payload).not.toBeNull();
  });

  it("judges every update-result fixture exactly as the corpus says", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { workspaceId, box } = await readyWorkspaceBox(h, cookie);

    for (const [name, fixture] of fixtures<ResultFixture>("result-")) {
      await env.DB
        .prepare("UPDATE machines SET box_update_requested = 1, box_image_reported = NULL WHERE workspace_id = ?1")
        .bind(workspaceId)
        .run();
      const response = await appRequest(h.app, "/workspaces/self/box-update-result", {
        method: "POST",
        headers: { ...boxHeaders(box), "Content-Type": "application/json" },
        body: JSON.stringify(fixture.request),
      });
      const columns = await workspaceUpdateColumns(workspaceId);
      if (fixture.accepts) {
        expect(response.status, name).toBe(204);
        // Every accepted report clears the flag and stores the ref, whatever
        // the outcome: a failed attempt must never re-arm a kill-everything
        // operation on its own.
        expect(columns.box_update_requested, name).toBe(0);
        expect(columns.box_image_reported, name).toBe(fixture.request.ref);
      } else {
        expect(response.status, name).toBe(400);
        expect(columns.box_update_requested, name).toBe(1);
        expect(columns.box_image_reported, name).toBeNull();
      }
    }
  });

  it("gates the session route on canControlWorkspace", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { workspaceId } = await readyWorkspaceBox(h, cookie);
    const stranger = await sameOrgSession("member-nobody");
    const admin = await sameOrgSession("member-admin", "admin");

    const denied = await appRequest(h.app, `/workspaces/${workspaceId}/box-update`, {
      method: "POST",
      headers: { Cookie: stranger.cookie },
    });
    expect(denied.status).toBe(403);
    expect((await workspaceUpdateColumns(workspaceId)).box_update_requested).toBe(0);

    const asOwner = await appRequest(h.app, `/workspaces/${workspaceId}/box-update`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(asOwner.status).toBe(204);
    expect((await workspaceUpdateColumns(workspaceId)).box_update_requested).toBe(1);

    const asAdmin = await appRequest(h.app, `/workspaces/${workspaceId}/box-update`, {
      method: "POST",
      headers: { Cookie: admin.cookie },
    });
    expect(asAdmin.status).toBe(204);

    const missing = await appRequest(h.app, "/workspaces/not-a-workspace/box-update", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(missing.status).toBe(404);
  });
});
