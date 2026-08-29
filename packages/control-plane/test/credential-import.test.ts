import type { ImportWorkspaceCredentialsResponse, WorkspaceView } from "@blitzos/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { parseEnvText } from "../core/workspace-credential-import.js";
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

describe("env text parser", () => {
  it("parses the plain slice of dotenv and keeps values literal", () => {
    const { entries, linesRead } = parseEnvText(
      "# canary\nA_KEY=plain\nexport B_KEY=exported\nC_KEY=\"quoted \"\nD_KEY='single'\n\n",
    );
    expect(linesRead).toBe(6);
    expect(entries).toEqual([
      { name: "A_KEY", line: 2, value: "plain" },
      { name: "B_KEY", line: 3, value: "exported" },
      { name: "C_KEY", line: 4, value: "quoted " },
      { name: "D_KEY", line: 5, value: "single" },
    ]);
  });

  it("refuses per line and names each reason", () => {
    const { entries } = parseEnvText(
      "not a line\n1BAD=x\nEMPTY=\nPEM=\"-----BEGIN\nA=1\nA=2\n",
    );
    expect(entries.map(({ name, reason }) => [name, reason])).toEqual([
      ["not", "not a NAME=value line"],
      ["1BAD", "name must be an environment variable name"],
      ["EMPTY", "empty value"],
      ["PEM", "value spans more than one line; base64-encode it first"],
      ["A", "superseded by line 6"],
      ["A", undefined],
    ]);
  });
});

const fixtureSources = import.meta.glob<string>(
  "../../schema/fixtures/credential-import/**/*.json",
  { eager: true, import: "default", query: "?raw" },
);

function fixture(name: string): unknown {
  const entry = Object.entries(fixtureSources).find(([path]) => path.endsWith(name));
  if (entry === undefined) throw new Error(`fixture ${name} not found`);
  return JSON.parse(entry[1]);
}

describe("credential import routes", () => {
  beforeEach(resetDatabase);

  it("produces the shared fixture byte for byte, so the Go consumer stays equal", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        credentials: [
          { name: "CF_TOKEN", value: "old_value" },
          { name: "SAME_KEY", value: "same_value" },
        ],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const imported = await appRequest(app, `/workspaces/${workspace.id}/credentials/dotenv`, {
      ...json({
        text: 'CF_TOKEN=new_value\nSAME_KEY=same_value\nSTRIPE_API_KEY=sk_test\nGOOGLE_SA_JSON="-----BEGIN\n',
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    await expect(imported.json()).resolves.toEqual(fixture("valid/response-mixed.json"));
  });

  it("imports through the session route and reports store-level outcomes", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        credentials: [{ name: "CF_TOKEN", value: "old_value" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const path = `/workspaces/${workspace.id}/credentials/dotenv`;

    const imported = await appRequest(app, path, {
      ...json({ text: "CF_TOKEN=new_value\nSTRIPE_API_KEY=sk_test\nbad name=1\n", label: "blitzos.env" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(imported.status).toBe(200);
    await expect(imported.json()).resolves.toEqual({
      results: [
        { name: "CF_TOKEN", line: 1, outcome: "rotated" },
        { name: "STRIPE_API_KEY", line: 2, outcome: "stored" },
        { name: "bad", line: 3, outcome: "refused", reason: "not a NAME=value line" },
      ],
      linesRead: 3,
    });

    // The same file again is all `unchanged`: a re-run must not read as a
    // wall of rotations, and it must write nothing.
    const again = await appRequest(app, path, {
      ...json({ text: "CF_TOKEN=new_value\nSTRIPE_API_KEY=sk_test\n" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    await expect(again.json<ImportWorkspaceCredentialsResponse>()).resolves.toMatchObject({
      results: [
        { name: "CF_TOKEN", outcome: "unchanged" },
        { name: "STRIPE_API_KEY", outcome: "unchanged" },
      ],
    });

    // What was imported is what the box pulls: same names, new value, label
    // on the workspace view.
    const token = await boxTokenFor(app, providers, workspace.id);
    const minted = await appRequest(app, "/workspaces/self/connections/CF_TOKEN/token", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    await expect(minted.json()).resolves.toMatchObject({ token: "new_value" });
    await expect(appRequest(app, `/workspaces/${workspace.id}`, {
      headers: { Cookie: cookie },
    }).then((response) => response.json())).resolves.toMatchObject({
      workspace: {
        credentials: [
          { name: "CF_TOKEN", label: "blitzos.env" },
          { name: "STRIPE_API_KEY", label: "blitzos.env" },
        ],
      },
    });
  });

  it("dry run reports the same outcomes and writes nothing", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      ...json({ machineTypeId: "small" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;

    const checked = await appRequest(app, `/workspaces/${workspace.id}/credentials/dotenv`, {
      ...json({ text: "STRIPE_API_KEY=sk_test\n", dryRun: true }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    await expect(checked.json()).resolves.toMatchObject({
      results: [{ name: "STRIPE_API_KEY", outcome: "stored" }],
    });
    await expect(appRequest(app, `/workspaces/${workspace.id}`, {
      headers: { Cookie: cookie },
    }).then((response) => response.json())).resolves.toMatchObject({
      workspace: { credentials: [] },
    });
  });

  it("gates both planes on the workspace admin role", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const member = await sameOrgSession("import-member");
    const created = await appRequest(app, "/workspaces", {
      ...json({
        machineTypeId: "small",
        members: [{ membershipId: member.membershipId, role: "member" }],
      }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const workspace = (await created.json<CreatedWorkspace>()).workspace;
    const body = json({ text: "STRIPE_API_KEY=sk_test\n" });

    // Session plane: a stored `member` may use credentials, not import them.
    expect((await appRequest(app, `/workspaces/${workspace.id}/credentials/dotenv`, {
      ...body,
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);

    // Box plane: the acting member is the machine's member, so the owner's
    // box imports and the member's box is refused with the same gate. The
    // fake provider keys its workspace-id record by the LAST machine
    // provisioned, so each box enrols through its own machine's callback.
    const ownerCallback = new URL(
      await workspacePhoneHomeUrl(providers, workspace.id, "personal"),
    );
    const ownerReady = await appRequest(app, ownerCallback.pathname, {
      ...json({ pub_key_ed25519: "ssh-ed25519 AAAAowner" }),
    });
    const ownerToken = (await ownerReady.json<{ access_token: string }>()).access_token;
    const ownerImport = await appRequest(app, "/workspaces/self/credentials/dotenv", {
      ...body,
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    });
    expect(ownerImport.status).toBe(200);
    await expect(ownerImport.json()).resolves.toMatchObject({
      results: [{ name: "STRIPE_API_KEY", outcome: "stored" }],
    });

    const memberCallback = new URL(
      await workspacePhoneHomeUrl(providers, workspace.id, member.membershipId),
    );
    const memberReady = await appRequest(app, memberCallback.pathname, {
      ...json({ pub_key_ed25519: "ssh-ed25519 AAAAmember" }),
    });
    const memberToken = (await memberReady.json<{ access_token: string }>()).access_token;
    expect((await appRequest(app, "/workspaces/self/credentials/dotenv", {
      ...body,
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
    })).status).toBe(403);
  });
});
