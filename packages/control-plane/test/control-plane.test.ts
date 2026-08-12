import type {
  FeedResponse,
  ListMachineTypesResponse,
  PollResponse,
  RegisterKeysResponse,
  WorkspaceView,
} from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runInvariantSweep, runOrphanDestroy } from "../src/janitors.js";
import {
  appRequest,
  createWorkspace,
  enrollBox,
  harness,
  operatorSession,
  phoneHomeUrl,
  resetDatabase,
} from "./helpers.js";

interface WorkspaceResponse {
  workspace: WorkspaceView;
}

describe("control plane security and lifecycle", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("rejects an absent or wrong operator key with 401", async () => {
    const { app } = harness();
    const absent = await appRequest(app, "/sessions", { method: "POST" });
    const wrong = await appRequest(app, "/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(absent.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it("lists machine types for an authenticated operator", async () => {
    const { app, providers } = harness();
    const unauthenticated = await appRequest(app, "/machine-types");
    expect(unauthenticated.status).toBe(401);

    const cookie = await operatorSession(app);
    const response = await appRequest(app, "/machine-types", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json<ListMachineTypesResponse>()).toEqual({
      machineTypes: await providers.listMachineTypes(),
    });
  });

  it("rejects a wrong phone_home token and rejects the capability's second use", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const callback = phoneHomeUrl(providers, workspace.id);

    const wrong = await app.request(
      `${callback}wrong`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    expect(wrong.status).toBe(401);

    const first = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    const second = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });

  it("rejects a box A token acting as box B in the registry", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const boxA = await enrollBox(app, cookie);
    const boxB = await enrollBox(app, cookie);
    const response = await appRequest(app, `/boxes/${boxB.box_id}/broker`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${boxA.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        host: "broker-b.example",
        port: 22,
        sshHostPublicKey: "ssh-ed25519 AAAAbrokerb",
      }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects broker box A pulling broker box B's slice", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const boxA = await enrollBox(app, cookie);
    const boxB = await enrollBox(app, cookie);
    for (const [box, host] of [
      [boxA, "broker-a.example"],
      [boxB, "broker-b.example"],
    ] as const) {
      const enrollment = await appRequest(app, `/boxes/${box.box_id}/broker`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${box.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          host,
          port: 22,
          sshHostPublicKey: "ssh-ed25519 AAAAbroker",
        }),
      });
      expect(enrollment.status).toBe(204);
    }
    const response = await appRequest(app, `/boxes/${boxB.box_id}/feed`, {
      headers: { Authorization: `Bearer ${boxA.access_token}` },
    });
    expect(response.status).toBe(403);
  });

  it("rejects a refresh token after it has rotated away", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const box = await enrollBox(app, cookie);
    const refresh = () =>
      appRequest(app, "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: box.refresh_token,
        }),
      });

    expect((await refresh()).status).toBe(200);
    const rotatedAway = await refresh();
    expect(rotatedAway.status).toBe(400);
    expect(await rotatedAway.json()).toEqual({ error: "invalid_grant" });
  });

  it("keeps destroyed terminal and returns the same tombstone", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const first = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const tombstone = await first.json<WorkspaceResponse>();
    const second = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(await second.json()).toEqual(tombstone);
    expect(tombstone.workspace.phase).toBe("destroyed");
    expect(providers.destroyCalls).toBe(1);
  });

  it("runs create → phone_home → ready → destroy → tombstone with strictly increasing revisions", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const revisions: number[] = [];
    providers.onCreate = async (id) => {
      const revision = await env.DB
        .prepare("SELECT revision FROM workspaces WHERE id = ?1")
        .bind(id)
        .first<number>("revision");
      if (revision !== null) revisions.push(revision);
    };
    providers.onDestroy = async (id) => {
      const revision = await env.DB
        .prepare("SELECT revision FROM workspaces WHERE id = ?1")
        .bind(id)
        .first<number>("revision");
      if (revision !== null) revisions.push(revision);
    };

    const volumeResponse = await appRequest(app, "/volumes", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "state", sizeGb: 20, location: "test" }),
    });
    const volume = await volumeResponse.json<{ volume: { id: string } }>();
    const creating = await createWorkspace(app, cookie, volume.volume.id);
    revisions.push(creating.revision);
    expect(creating.phase).toBe("creating");

    const callback = phoneHomeUrl(providers, creating.id);
    const phoneHome = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    expect(phoneHome.status).toBe(200);
    const credential = await phoneHome.json<{ access_token: string; refresh_token: string }>();
    expect(credential.access_token).not.toBe(credential.refresh_token);

    const poll = await appRequest(app, "/workspaces", { headers: { Cookie: cookie } });
    const ready = (await poll.json<PollResponse>()).workspaces[0];
    expect(ready?.phase).toBe("ready");
    if (ready === undefined) throw new Error("workspace missing from poll");
    revisions.push(ready.revision);

    const destroy = await appRequest(app, `/workspaces/${creating.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const tombstone = (await destroy.json<WorkspaceResponse>()).workspace;
    revisions.push(tombstone.revision);
    expect(tombstone.phase).toBe("destroyed");
    expect(tombstone.ssh).toBeNull();
    expect(tombstone.volumeId).toBe(volume.volume.id);
    expect(revisions).toEqual([1, 2, 3, 4, 5]);
    expect(providers.detachCalls).toBe(1);
    expect(providers.volumes.get(volume.volume.id)?.status).toBe("available");
  });

  it("assigns workspace keys to the least-loaded broker and serves ETag/304", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const broker = await enrollBox(app, cookie);
    expect(
      (
        await appRequest(app, `/boxes/${broker.box_id}/broker`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${broker.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            host: "broker.example",
            port: 22,
            sshHostPublicKey: "ssh-ed25519 AAAAbroker",
          }),
        })
      ).status,
    ).toBe(204);

    const workspace = await createWorkspace(app, cookie);
    const callback = phoneHomeUrl(providers, workspace.id);
    const ready = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    const box = await ready.json<{ box_id: string; access_token: string }>();
    const registration = await appRequest(app, `/boxes/${box.box_id}/keys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${box.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        keys: [
          { pubkey: "ssh-ed25519 AAAAmint", op: "mint" },
          { pubkey: "ssh-ed25519 AAAAdeposit", op: "deposit" },
        ],
      }),
    });
    expect(registration.status).toBe(200);
    expect(await registration.json<RegisterKeysResponse>()).toEqual({
      memberUnixName: "operator",
      broker: {
        host: "broker.example",
        port: 22,
        sshHostPublicKey: "ssh-ed25519 AAAAbroker",
      },
    });

    const feed = await appRequest(app, `/boxes/${broker.box_id}/feed`, {
      headers: { Authorization: `Bearer ${broker.access_token}` },
    });
    expect(feed.status).toBe(200);
    const etag = feed.headers.get("etag");
    const body = await feed.json<FeedResponse>();
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toMatchObject({
      unixName: "operator",
      harnesses: ["claude", "codex"],
    });
    expect(body.members[0]?.keys).toEqual(
      expect.arrayContaining([
        { pubkey: "ssh-ed25519 AAAAmint", op: "mint" },
        { pubkey: "ssh-ed25519 AAAAdeposit", op: "deposit" },
      ]),
    );
    if (etag === null) throw new Error("feed ETag missing");
    const notModified = await appRequest(app, `/boxes/${broker.box_id}/feed`, {
      headers: {
        Authorization: `Bearer ${broker.access_token}`,
        "If-None-Match": etag,
      },
    });
    expect(notModified.status).toBe(304);

    const removed = await appRequest(app, `/boxes/${broker.box_id}/broker`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${broker.access_token}` },
    });
    expect(removed.status).toBe(204);
    const assignment = await env.DB
      .prepare("SELECT broker_box_id FROM boxes WHERE id = ?1")
      .bind(box.box_id)
      .first<string>("broker_box_id");
    expect(assignment).toBeNull();
  });

  it("sweeps stale creation to error and completes orphaned destroy work", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    await env.DB
      .prepare("UPDATE workspaces SET updated_at = 0 WHERE id = ?1")
      .bind(workspace.id)
      .run();
    expect(await runInvariantSweep(env.DB, 2 * 60 * 60 * 1000)).toBe(1);
    const errored = await env.DB
      .prepare("SELECT phase, revision FROM workspaces WHERE id = ?1")
      .bind(workspace.id)
      .first<{ phase: string; revision: number }>();
    expect(errored).toEqual({ phase: "error", revision: 3 });

    await env.DB
      .prepare("UPDATE workspaces SET phase = 'destroying', revision = revision + 1 WHERE id = ?1")
      .bind(workspace.id)
      .run();
    expect(await runOrphanDestroy(env.DB, providers, providers)).toBe(1);
    const destroyed = await env.DB
      .prepare("SELECT phase, revision FROM workspaces WHERE id = ?1")
      .bind(workspace.id)
      .first<{ phase: string; revision: number }>();
    expect(destroyed).toEqual({ phase: "destroyed", revision: 5 });
  });
});
