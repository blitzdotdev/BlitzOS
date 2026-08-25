import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceSessionResponse } from "@blitzos/schema";
import type { JsonValue } from "../core/http.js";
import {
  appRequest,
  createWorkspace,
  harness,
  operatorSession,
  resetDatabase,
  sameOrgSession,
} from "./helpers.js";

// Control-plane side of the `org presence` contract: the request consumer
// (which PUT bodies are accepted) and the snapshot producer (what the
// organization sees, authorized and redacted). The browser side — the request
// producer and the snapshot consumer — is pinned against the same corpus in
// packages/webapp/test/presence-conformance.test.ts.
interface RequestFixture {
  body: JsonValue;
  status: number;
}

interface SnapshotFixture {
  response: JsonValue;
  accepts: boolean;
}

const requestSources = import.meta.glob<string>(
  "../../schema/fixtures/presence/requests/*.json",
  { eager: true, import: "default", query: "?raw" },
);
const snapshotSources = import.meta.glob<string>(
  "../../schema/fixtures/presence/snapshots/*.json",
  { eager: true, import: "default", query: "?raw" },
);

function named<T>(sources: Record<string, string>): Array<[string, T]> {
  return Object.entries(sources)
    // SAFETY: Trusted local fixtures authored to the shapes declared above;
    // the browser conformance test reads the same files.
    .map(([path, source]): [string, T] => [path.slice(path.lastIndexOf("/") + 1), JSON.parse(source) as T])
    .sort(([left], [right]) => left.localeCompare(right));
}

function substitute(source: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    source,
  );
}

/** Replaces the values only this run knows with the fixture placeholders and
 * zeroes server timestamps, so a snapshot compares byte-for-byte. */
function normalized(value: JsonValue, values: Record<string, string>): JsonValue {
  const text = Object.entries(values).reduce(
    (json, [key, actual]) => json.replaceAll(JSON.stringify(actual), JSON.stringify(`{{${key}}}`)),
    JSON.stringify(value),
  );
  const zeroTimes = (node: JsonValue): JsonValue => {
    if (Array.isArray(node)) return node.map(zeroTimes);
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [
      key,
      key === "serverTime" || key === "lastSeenAt" ? 0 : zeroTimes(child),
    ]));
  };
  return zeroTimes(JSON.parse(text));
}

async function scenario() {
  const { app } = harness();
  const owner = await operatorSession(app);
  const mate = await sameOrgSession("mate");
  const workspace = await createWorkspace(app, owner);
  const other = await createWorkspace(app, owner);
  const created = await appRequest(app, `/workspaces/${workspace.id}/sessions`, {
    method: "POST",
    headers: { Cookie: owner, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "terminal", title: "Pairing shell" }),
  });
  const { session } = await created.json<WorkspaceSessionResponse>();
  const values = {
    "workspace": workspace.id,
    "workspace-name": workspace.name,
    "other-workspace": other.id,
    "session": session.id,
  };
  return { app, owner, mate, values };
}

describe("org presence fixtures (control plane)", () => {
  beforeEach(resetDatabase);

  it("answers every request fixture with its pinned status", async () => {
    const { app, owner, values } = await scenario();
    for (const [name, fixture] of named<RequestFixture>(requestSources)) {
      const response = await appRequest(app, `/presence/connections/${name.replace(/\.json$/u, "")}`, {
        method: "PUT",
        headers: { Cookie: owner, "Content-Type": "application/json" },
        body: substitute(JSON.stringify(fixture.body), values),
      });
      expect(response.status, name).toBe(fixture.status);
    }
  });

  it("produces the authorized and redacted snapshots exactly as pinned", async () => {
    const { app, owner, mate, values } = await scenario();
    const fixtures = new Map(named<SnapshotFixture>(snapshotSources));
    expect((await appRequest(app, "/presence/connections/owner-tab", {
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: substitute(JSON.stringify({
        workspaceId: "{{workspace}}",
        surfaces: [{ kind: "session", sessionId: "{{session}}" }],
        focusedSurface: 0,
        visible: true,
        focused: true,
      }), values),
    })).status).toBe(204);
    expect((await appRequest(app, "/presence/connections/mate-tab", {
      method: "PUT",
      headers: { Cookie: mate.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: null,
        surfaces: [],
        focusedSurface: null,
        visible: true,
        focused: false,
      }),
    })).status).toBe(204);

    const snapshotAs = async (cookie: string): Promise<JsonValue> => {
      const response = await appRequest(app, "/presence", { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      return normalized(await response.json<JsonValue>(), values);
    };
    expect(await snapshotAs(owner)).toEqual(fixtures.get("authorized.json")?.response);
    expect(await snapshotAs(mate.cookie)).toEqual(fixtures.get("redacted.json")?.response);
    // The redacted fixture is the load-bearing one: nothing that names the
    // workspace or its session may appear in it.
    const redacted = JSON.stringify(fixtures.get("redacted.json")?.response);
    expect(redacted).not.toContain("{{workspace");
    expect(redacted).not.toContain("{{session}}");
    expect(redacted).not.toContain("Pairing shell");
  });

  it("stamps every request fixture as either a browser-producible body or a server-only rejection", () => {
    for (const [name, fixture] of named<RequestFixture & { producer: JsonValue }>(requestSources)) {
      expect(fixture.status === 204 ? fixture.producer !== null : fixture.producer === null, name)
        .toBe(true);
    }
    expect(env.DB).toBeDefined();
  });
});
