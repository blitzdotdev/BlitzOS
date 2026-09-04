import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { parseBoxPayloadResult } from "../core/box-config.js";
import type { JsonValue } from "../core/http.js";
import type { BoxPayloadResultRequest, MachineView } from "../core/wire.js";
import {
  appRequest,
  enrollBox,
  harness,
  operatorSession,
  phoneHomeUrl,
  resetDatabase,
  type BoxCredential,
} from "./helpers.js";

// Control-plane consumer side of the payload-result half of box-payload v1.
// The in-box producer and its parser share this fixture corpus; this suite
// drives the real route so acceptance and persistence cannot drift apart.

const fixtureSources = import.meta.glob<string>(
  "../../schema/fixtures/box-payload/payload-result/**/*.json",
  { eager: true, import: "default", query: "?raw" },
);

function fixtureEntries(kind: "valid" | "invalid"): Array<[string, string]> {
  const marker = `/payload-result/${kind}/`;
  return Object.entries(fixtureSources)
    .filter(([path]) => path.includes(marker))
    .map(([path, source]): [string, string] => [path.slice(path.lastIndexOf("/") + 1), source])
    .sort(([left], [right]) => left.localeCompare(right));
}

function fixtureValue(source: string): JsonValue {
  // SAFETY: JSON.parse constructs only values in the recursive JsonValue
  // union; these are trusted, checked-in fixture bytes.
  return JSON.parse(source) as JsonValue;
}

type Harness = ReturnType<typeof harness>;

async function readyWorkspaceBox(
  { app, providers }: Harness,
  cookie: string,
): Promise<{ workspaceId: string; box: BoxCredential }> {
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

function report(app: Harness["app"], box: BoxCredential, source: string): Promise<Response> {
  return appRequest(app, "/workspaces/self/payload-result", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${box.access_token}`,
      "Content-Type": "application/json",
    },
    body: source,
  });
}

interface StoredPayloadReport {
  payload_reported: string | null;
  daemon_reported: string | null;
  payload_outcome: string | null;
  payload_reported_at: number | null;
}

async function storedPayloadReport(workspaceId: string): Promise<StoredPayloadReport> {
  const row = await env.DB.prepare(
    `SELECT payload_reported, daemon_reported, payload_outcome,
            payload_reported_at
     FROM machines WHERE workspace_id = ?1`,
  ).bind(workspaceId).first<StoredPayloadReport>();
  if (row === null) throw new Error("machine row missing");
  return row;
}

function expectedStored(input: BoxPayloadResultRequest) {
  return {
    payload_reported: input.version,
    daemon_reported: input.daemonVersion,
    payload_outcome: input.outcome,
  };
}

describe("box-payload result control-plane conformance", () => {
  beforeEach(resetDatabase);

  it("pins every payload-result fixture by name", () => {
    expect(fixtureEntries("valid").map(([name]) => name)).toEqual([
      "applied.json",
      "booted.json",
      "fetch-failed.json",
      "rolled-back.json",
      "start-failed.json",
      "unsupported.json",
      "up-to-date.json",
      "verify-failed.json",
    ]);
    expect(fixtureEntries("invalid").map(([name]) => name)).toEqual([
      "daemonVersion--empty.json",
      "detail--not-string.json",
      "outcome--unknown.json",
      "root--not-object.json",
      "version--unsafe.json",
    ]);
  });

  it("accepts, persists, and idempotently redelivers every valid report", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { workspaceId, box } = await readyWorkspaceBox(h, cookie);

    for (const [name, source] of fixtureEntries("valid")) {
      const input = parseBoxPayloadResult(fixtureValue(source));
      const first = await report(h.app, box, source);
      expect(first.status, name).toBe(204);
      const stored = await storedPayloadReport(workspaceId);
      expect(stored, name).toMatchObject(expectedStored(input));
      expect(stored.payload_reported_at, name).toBeGreaterThan(0);

      // A retry updates the same machine projection; there is no attempt row
      // to duplicate and a redelivery remains a successful no-op semantically.
      const retried = await report(h.app, box, source);
      expect(retried.status, `${name} retry`).toBe(204);
      expect(await storedPayloadReport(workspaceId), `${name} retry`)
        .toMatchObject(expectedStored(input));
    }
  });

  it("rejects every invalid report without overwriting the last true one", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { workspaceId, box } = await readyWorkspaceBox(h, cookie);
    const seed = fixtureEntries("valid").find(([name]) => name === "applied.json")?.[1];
    if (seed === undefined) throw new Error("applied payload-result fixture missing");
    expect((await report(h.app, box, seed)).status).toBe(204);
    const before = await storedPayloadReport(workspaceId);

    for (const [name, source] of fixtureEntries("invalid")) {
      expect((await report(h.app, box, source)).status, name).toBe(400);
      expect(await storedPayloadReport(workspaceId), name).toEqual(before);
    }
  });

  it("is box-authenticated and refuses a device box with no workspace", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const source = fixtureEntries("valid")[0]?.[1];
    if (source === undefined) throw new Error("valid payload-result fixture missing");

    const anonymous = await appRequest(h.app, "/workspaces/self/payload-result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: source,
    });
    expect(anonymous.status).toBe(401);

    const deviceBox = await enrollBox(h.app, cookie);
    expect((await report(h.app, deviceBox, source)).status).toBe(403);
  });

  it("carries the last report onto every required MachineView field", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { workspaceId, box } = await readyWorkspaceBox(h, cookie);
    const source = fixtureEntries("valid").find(([name]) => name === "rolled-back.json")?.[1];
    if (source === undefined) throw new Error("rolled-back payload-result fixture missing");
    const input = parseBoxPayloadResult(fixtureValue(source));

    const initialResponse = await appRequest(h.app, `/workspaces/${workspaceId}`, {
      headers: { Cookie: cookie },
    });
    const initial = await initialResponse.json<{
      workspace: { members: Array<{ machine: MachineView | null }> };
    }>();
    expect(initial.workspace.members[0]?.machine).toMatchObject({
      payloadVersion: null,
      daemonVersion: null,
      payloadOutcome: null,
      payloadReportedAt: null,
    });

    expect((await report(h.app, box, source)).status).toBe(204);

    const response = await appRequest(h.app, `/workspaces/${workspaceId}`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const { workspace } = await response.json<{
      workspace: { members: Array<{ machine: MachineView | null }> };
    }>();
    expect(workspace.members[0]?.machine).toMatchObject({
      payloadVersion: input.version,
      daemonVersion: input.daemonVersion,
      payloadOutcome: input.outcome,
      payloadReportedAt: expect.any(Number),
    });
  });
});
