import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { controlPlaneOriginFromEnv, deploymentBoxImage } from "../core/box-config.js";
import type { BoxConfigResponse, MachineView, WorkspaceMemberView } from "../core/wire.js";
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

interface UpdateColumns {
  box_update_requested: number;
  box_image_reported: string | null;
  box_image_tag_reported: string | null;
  box_update_outcome: string | null;
}

async function workspaceUpdateColumns(workspaceId: string): Promise<UpdateColumns> {
  const row = await env.DB
    .prepare(`SELECT box_update_requested, box_image_reported,
                     box_image_tag_reported, box_update_outcome
              FROM machines WHERE workspace_id = ?1`)
    .bind(workspaceId)
    .first<UpdateColumns>();
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
      "config-valid-tarball-ref.json",
      "config-valid-update-requested.json",
    ]);
    expect(fixtures<ResultFixture>("result-").map(([name]) => name)).toEqual([
      "result-missing-outcome.json",
      "result-missing-ref.json",
      "result-ref-with-space.json",
      "result-tag-with-space.json",
      "result-unknown-outcome.json",
      "result-valid-digest-mismatch.json",
      "result-valid-download-failed.json",
      "result-valid-extra-key.json",
      "result-valid-load-failed.json",
      "result-valid-manifest-tag.json",
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
    });
    // The emitted keys are exactly the ones the minimal accepted fixture (and
    // therefore the host parser) expects.
    const minimal = fixtures<ConfigFixture>("config-")
      .find(([name]) => name === "config-valid-minimal.json")?.[1];
    if (minimal === undefined) throw new Error("missing minimal box-config fixture");
    expect(Object.keys(body).sort()).toEqual(Object.keys(minimal.response).sort());
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

  it("judges every update-result fixture exactly as the corpus says", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { workspaceId, box } = await readyWorkspaceBox(h, cookie);

    for (const [name, fixture] of fixtures<ResultFixture>("result-")) {
      await env.DB
        .prepare(`UPDATE machines
                  SET box_update_requested = 1, box_image_reported = NULL,
                      box_image_tag_reported = 'seeded-at-boot', box_update_outcome = NULL
                  WHERE workspace_id = ?1`)
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
        expect(columns.box_update_outcome, name).toBe(fixture.request.outcome);
        // A host that sends no `tag` predates the field, and the value the
        // row already holds stays the best answer there is — nulling it would
        // throw away the image the boot was armed with.
        expect(columns.box_image_tag_reported, name)
          .toBe(fixture.request.tag ?? "seeded-at-boot");
      } else {
        expect(response.status, name).toBe(400);
        expect(columns.box_update_requested, name).toBe(1);
        expect(columns.box_image_reported, name).toBeNull();
        expect(columns.box_update_outcome, name).toBeNull();
        expect(columns.box_image_tag_reported, name).toBe("seeded-at-boot");
      }
    }
  });

  // The "Update machine" button. It names ONE machine whoever calls it, which
  // is the whole difference from the workspace route below: a user who clicked
  // a button in their own machine dialog did not ask to restart a colleague's
  // work, and an admin pressing it must not accidentally fan out.
  it("lets a member request an update for their own machine and nobody else's", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { workspaceId } = await readyWorkspaceBox(h, cookie);
    const machine = await env.DB
      .prepare("SELECT id FROM machines WHERE workspace_id = ?1")
      .bind(workspaceId)
      .first<{ id: string }>();
    if (machine === null) throw new Error("machine row missing");
    const stranger = await sameOrgSession("member-nobody");

    const denied = await appRequest(h.app, `/machines/${machine.id}/box-update`, {
      method: "POST",
      headers: { Cookie: stranger.cookie },
    });
    expect(denied.status).toBe(403);
    expect((await workspaceUpdateColumns(workspaceId)).box_update_requested).toBe(0);

    const requested = await appRequest(h.app, `/machines/${machine.id}/box-update`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(requested.status).toBe(200);
    // It answers with the machine, so the dialog renders the pending flag
    // without waiting for the next poll.
    const { machine: view } = await requested.json<{ machine: MachineView }>();
    expect(view.id).toBe(machine.id);
    expect(view.boxUpdateRequested).toBe(true);
    expect((await workspaceUpdateColumns(workspaceId)).box_update_requested).toBe(1);

    const missing = await appRequest(h.app, "/machines/not-a-machine/box-update", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(missing.status).toBe(404);
  });

  // Under an R2 manifest pin the ref never changes between rebakes, so the
  // machine's own reported TAG is the only thing that can answer the question
  // the button's label depends on.
  it("projects the reported image against the deployment's own pin", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { workspaceId } = await readyWorkspaceBox(h, cookie);

    const beforeReport = await appRequest(h.app, `/workspaces/${workspaceId}`, {
      headers: { Cookie: cookie },
    });
    const before = await beforeReport.json<{ workspace: { members: WorkspaceMemberView[] } }>();
    const seeded = before.workspace.members[0]?.machine;
    // A freshly armed boot already knows its image, so "is an update
    // available" has an answer before any update is ever attempted.
    expect(seeded?.boxImage).toBe(env.BOX_IMAGE_TAG);
    expect(seeded?.boxImageTarget).toBe(env.BOX_IMAGE_TAG);
    expect(seeded?.boxUpdateOutcome).toBeNull();

    await env.DB
      .prepare("UPDATE machines SET box_image_tag_reported = ?2, box_update_outcome = ?3 WHERE workspace_id = ?1")
      .bind(workspaceId, "blitz-box:2026-08-01", "unsupported")
      .run();

    const stale = await appRequest(h.app, `/workspaces/${workspaceId}`, {
      headers: { Cookie: cookie },
    });
    const view = await stale.json<{ workspace: { members: WorkspaceMemberView[] } }>();
    const machine = view.workspace.members[0]?.machine;
    expect(machine?.boxImage).toBe("blitz-box:2026-08-01");
    // The deployment pins a manifest URL, so the concrete image is the tag
    // inside it — never the URL, which is the same across every rebake.
    expect(machine?.boxImageTarget).toBe(env.BOX_IMAGE_TAG);
    expect(machine?.boxImageTarget).not.toBe(env.BOX_IMAGE_REF);
    // The honest signal for a host whose emitted updater predates the manifest
    // branch: it reported `unsupported`, and it can never self-update.
    expect(machine?.boxUpdateOutcome).toBe("unsupported");
  });

  it("names the tag rather than the ref when the deployment pins a manifest", () => {
    // Registry mode: the ref IS the image and the tag var is empty.
    expect(deploymentBoxImage({ boxImageRef: "ghcr.io/o/box:v3", boxImageTag: "" }))
      .toBe("ghcr.io/o/box:v3");
    // Manifest mode: the URL is identical across rebakes, the tag is not.
    expect(deploymentBoxImage({
      boxImageRef: "https://cp.example/box-image/manifest.json",
      boxImageTag: "blitz-box:2026-08-31",
    })).toBe("blitz-box:2026-08-31");
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
