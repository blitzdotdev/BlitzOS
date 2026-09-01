import type { WorkspaceView } from "@blitzos/schema";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appRequest,
  boxTokenFor,
  harness,
  operatorSession,
  resetDatabase,
  sameOrgSession,
  workspacePhoneHomeUrl,
} from "./helpers.js";

function json(body: object, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface CreatedWorkspace {
  workspace: WorkspaceView;
}

const fixtureSources = import.meta.glob<string>(
  "../../schema/fixtures/credential-list/**/*.json",
  { eager: true, import: "default", query: "?raw" },
);

function fixture(name: string): unknown {
  const entry = Object.entries(fixtureSources).find(([path]) => path.endsWith(name));
  if (entry === undefined) throw new Error(`fixture ${name} not found`);
  return JSON.parse(entry[1]);
}

describe("workspace credential comments", () => {
  beforeEach(resetDatabase);

  it("stores a comment, keeps it across a rotation, and clears it on explicit null", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      ...json({ machineTypeId: "small" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const path = `/workspaces/${workspace.id}/credentials`;
    const view = () => appRequest(app, `/workspaces/${workspace.id}`, {
      headers: { Cookie: cookie },
    }).then((response) => response.json<CreatedWorkspace>());

    expect((await appRequest(app, path, {
      ...json({
        name: "STRIPE_API_KEY",
        value: "sk_one",
        comment: "test-mode key, safe for CI",
      }, "PUT"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(201);
    await expect(view()).resolves.toMatchObject({
      workspace: {
        credentials: [{ name: "STRIPE_API_KEY", comment: "test-mode key, safe for CI" }],
      },
    });

    // A rotation that says nothing about the comment keeps it: the value
    // changed, not what the value is for. The env-file import path writes
    // through the same statement, so a re-import cannot erase comments.
    const imported = await appRequest(app, `/workspaces/${workspace.id}/credentials/dotenv`, {
      ...json({ text: "STRIPE_API_KEY=sk_two\n" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    await expect(imported.json()).resolves.toMatchObject({
      results: [{ name: "STRIPE_API_KEY", outcome: "rotated" }],
    });
    await expect(view()).resolves.toMatchObject({
      workspace: {
        credentials: [{ name: "STRIPE_API_KEY", comment: "test-mode key, safe for CI" }],
      },
    });

    // Explicit null is the one way to clear.
    expect((await appRequest(app, path, {
      ...json({ name: "STRIPE_API_KEY", value: "sk_three", comment: null }, "PUT"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(201);
    await expect(view()).resolves.toMatchObject({
      workspace: { credentials: [{ name: "STRIPE_API_KEY", comment: null }] },
    });

    // A comment is one printed line.
    expect((await appRequest(app, path, {
      ...json({ name: "STRIPE_API_KEY", value: "sk_four", comment: "two\nlines" }, "PUT"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    })).status).toBe(400);
  });

  it("serves the shared list fixture byte for byte, so the Go consumer stays equal", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        credentials: [
          {
            name: "CF_TOKEN",
            value: "cf_value",
            comment: "canary Cloudflare API token; deploys the control plane",
          },
          { name: "PLAIN_KEY", value: "plain_value" },
        ],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const token = await boxTokenFor(app, providers, workspace.id);
    const listed = await appRequest(app, "/workspaces/self/credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual(fixture("valid/list-mixed.json"));
  });

  it("gates the box-plane put on the workspace admin role, list on membership alone", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const member = await sameOrgSession("comment-member");
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        members: [{ membershipId: member.membershipId, role: "member" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const put = json({
      name: "HETZNER_LAB_TOKEN",
      value: "hz_value",
      comment: "lab project only; never the shared prod project",
    }, "PUT");

    const ownerCallback = new URL(
      await workspacePhoneHomeUrl(providers, workspace.id, "personal"),
    );
    const ownerReady = await appRequest(app, ownerCallback.pathname, {
      ...json({ pub_key_ed25519: "ssh-ed25519 AAAAowner" }),
    });
    const ownerToken = (await ownerReady.json<{ access_token: string }>()).access_token;
    const stored = await appRequest(app, "/workspaces/self/credentials", {
      ...put,
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    });
    expect(stored.status).toBe(201);
    await expect(stored.json()).resolves.toEqual({
      credential: {
        name: "HETZNER_LAB_TOKEN",
        label: null,
        comment: "lab project only; never the shared prod project",
        createdAt: expect.any(Number),
      },
    });

    const memberCallback = new URL(
      await workspacePhoneHomeUrl(providers, workspace.id, member.membershipId),
    );
    const memberReady = await appRequest(app, memberCallback.pathname, {
      ...json({ pub_key_ed25519: "ssh-ed25519 AAAAmember" }),
    });
    const memberToken = (await memberReady.json<{ access_token: string }>()).access_token;
    expect((await appRequest(app, "/workspaces/self/credentials", {
      ...put,
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
    })).status).toBe(403);

    // The member's machine still READS the store — comments exist so an
    // agent can pick the right key.
    await expect(appRequest(app, "/workspaces/self/credentials", {
      headers: { Authorization: `Bearer ${memberToken}` },
    }).then((response) => response.json())).resolves.toEqual({
      credentials: [{
        name: "HETZNER_LAB_TOKEN",
        comment: "lab project only; never the shared prod project",
      }],
    });
  });
});
