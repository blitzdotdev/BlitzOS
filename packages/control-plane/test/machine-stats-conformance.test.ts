import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appRequest,
  harness,
  operatorSession,
  phoneHomeUrl,
  resetDatabase,
  type BoxCredential,
} from "./helpers.js";

// Control-plane side of the machine-stats contract. This Worker consumes the
// guest disk report. The updater at rootfs/usr/local/libexec/blitz-payload sends
// one per successful five-minute tick. The same corpus is pinned by
// packages/box/guest-tests/test/machine-stats-conformance.test.ts.

interface StatsFixture {
  request: Record<string, unknown>;
  accepts: boolean;
}

const fixtureSources = import.meta.glob<string>(
  "../../schema/fixtures/machine-stats/*.json",
  { eager: true, import: "default", query: "?raw" },
);

function fixtures(): Array<[string, StatsFixture]> {
  return Object.entries(fixtureSources)
    .map(([path, source]): [string, string] => [path.slice(path.lastIndexOf("/") + 1), source])
    // SAFETY: The machine-stats fixtures are trusted local test data authored
    // to the { request, accepts } shape; the guest test pins the same corpus.
    .map(([name, source]): [string, StatsFixture] => [name, JSON.parse(source) as StatsFixture])
    .sort(([left], [right]) => left.localeCompare(right));
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

function report(
  app: Harness["app"],
  box: BoxCredential,
  body: unknown,
): Promise<Response> {
  return appRequest(app, "/workspaces/self/machine-stats", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${box.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function storedStats(
  workspaceId: string,
): Promise<{ disk_used_percent: number | null; disk_reported_at: number | null }> {
  const row = await env.DB
    .prepare("SELECT disk_used_percent, disk_reported_at FROM machines WHERE workspace_id = ?1")
    .bind(workspaceId)
    .first<{ disk_used_percent: number | null; disk_reported_at: number | null }>();
  if (row === null) throw new Error("machine row missing");
  return row;
}

describe("machine-stats control-plane conformance", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("pins the shared machine-stats fixture corpus", () => {
    expect(fixtures().map(([name]) => name)).toEqual([
      "invalid-fractional-percent.json",
      "invalid-missing-percent.json",
      "invalid-negative-percent.json",
      "invalid-null-percent.json",
      "invalid-over-hundred.json",
      "invalid-string-percent.json",
      "valid-extra-key.json",
      "valid-full.json",
      "valid-mid.json",
      "valid-zero.json",
    ]);
  });

  it("answers every fixture exactly as the corpus says it must", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { workspaceId, box } = await readyWorkspaceBox(h, cookie);

    for (const [name, fixture] of fixtures()) {
      const response = await report(h.app, box, fixture.request);
      expect(response.status, name).toBe(fixture.accepts ? 204 : 400);
      if (fixture.accepts) {
        const stored = await storedStats(workspaceId);
        expect(stored.disk_used_percent, name).toBe(fixture.request.diskUsedPercent);
        expect(stored.disk_reported_at, name).toBeGreaterThan(0);
      }
    }
  });

  it("leaves the last true figure alone when a report is refused", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const { workspaceId, box } = await readyWorkspaceBox(h, cookie);

    expect((await report(h.app, box, { diskUsedPercent: 62 })).status).toBe(204);
    expect((await report(h.app, box, { diskUsedPercent: 900 })).status).toBe(400);

    expect((await storedStats(workspaceId)).disk_used_percent).toBe(62);
  });

  it("writes only the reporting machine's own row", async () => {
    const h = harness();
    const cookie = await operatorSession();
    const first = await readyWorkspaceBox(h, cookie);
    const second = await readyWorkspaceBox(h, cookie);

    expect((await report(h.app, first.box, { diskUsedPercent: 12 })).status).toBe(204);

    expect((await storedStats(first.workspaceId)).disk_used_percent).toBe(12);
    expect((await storedStats(second.workspaceId)).disk_used_percent).toBeNull();
  });

  it("refuses an unauthenticated report", async () => {
    const h = harness();
    const response = await appRequest(h.app, "/workspaces/self/machine-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ diskUsedPercent: 10 }),
    });
    expect(response.status).toBe(401);
  });

  it("carries the reported figure onto the wire as volumeUsedPercent", async () => {
    const h = harness();
    // The fake places no volume unless a suite asks it to, and the wire field
    // is about the volume, so this suite asks.
    h.providers.volumeLocation = () => "test";
    const cookie = await operatorSession();
    const { workspaceId, box } = await readyWorkspaceBox(h, cookie);
    expect((await report(h.app, box, { diskUsedPercent: 62 })).status).toBe(204);

    const poll = await appRequest(h.app, "/workspaces", { headers: { Cookie: cookie } });
    expect(poll.status).toBe(200);
    const { workspaces } = await poll.json<{
      workspaces: Array<{
        id: string;
        members: Array<{ machine: { volumeId: string | null; volumeUsedPercent: number | null } | null }>;
      }>;
    }>();
    const machine = workspaces.find(({ id }) => id === workspaceId)?.members[0]?.machine;
    // The fake provider gives this machine a volume, so the percentage is
    // about something a member keeps files on and travels.
    expect(machine?.volumeId).not.toBeNull();
    expect(machine?.volumeUsedPercent).toBe(62);
  });
});
