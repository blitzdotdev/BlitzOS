import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HETZNER_STOCK_IMAGE, HetznerProvider } from "../core/compute/hetzner.js";
import { runVolumeRetentionSweep } from "../core/janitors.js";
import {
  preferredVolumeName,
  uniqueVolumeName,
  VOLUME_RETENTION_MS,
} from "../core/workspace-volumes.js";
import type { VolumeProvider } from "../core/compute/types.js";
import { FakeProviders, operatorSession, resetDatabase, testRuntime } from "./helpers.js";

function recordingFetcher(handler: (attempt: number) => Response) {
  const bodies: string[] = [];
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return handler(bodies.length);
  };
  return { bodies, fetcher };
}

const SERVER = { server: { id: 4242, public_net: { ipv4: { ip: "203.0.113.9" } } } };

const CREATE = {
  workspaceId: "w-1",
  machineId: "m-1",
  machineTypeId: "cx23@hel1",
  phoneHomeUrl: "https://cp.example/phone-home",
  userData: "#!/bin/bash",
};

describe("workspace volumes", () => {
  it("names the volume after the workspace, and falls back to a unique name", () => {
    // Workspace names are not unique and Hetzner volume names must be, so the
    // preferred name is the workspace name and the fallback carries the id.
    expect(preferredVolumeName("Team Alpha / staging!")).toBe("team-alpha-staging");
    expect(uniqueVolumeName("amber-moose", "0f2b8c1a-1111-2222-3333-444455556666"))
      .toBe("amber-moose-0f2b8c1a");
  });

  it("attaches the volume in the create call, not after the VM exists", async () => {
    // The bootstrap scans /dev/disk/by-id once with no retry, so attaching
    // afterwards raced that scan and could leave the box with no disk.
    const { bodies, fetcher } = recordingFetcher(() => Response.json(SERVER));
    await new HetznerProvider("t", { fetcher }).createVm({ ...CREATE, volumeIds: ["20001"] });
    expect(JSON.parse(bodies[0] ?? "{}").volumes).toEqual([20001]);
  });

  it("boots the configured golden image", async () => {
    const { bodies, fetcher } = recordingFetcher(() => Response.json(SERVER));
    await new HetznerProvider("t", { fetcher, serverImages: "hel1=163000001" }).createVm(CREATE);
    expect(JSON.parse(bodies[0] ?? "{}").image).toBe("163000001");
  });

  it("falls back to stock Ubuntu when the snapshot is gone", async () => {
    // A deleted snapshot must not break every create. Hetzner answered, so
    // nothing was allocated and the second POST cannot duplicate a server.
    const { bodies, fetcher } = recordingFetcher((attempt) =>
      attempt === 1
        ? Response.json({ error: { code: "not_found", message: "image not found" } }, { status: 404 })
        : Response.json(SERVER));
    const provider = new HetznerProvider("t", { fetcher, serverImages: "*=163000001" });
    expect((await provider.createVm(CREATE)).id).toBe("4242");
    expect(JSON.parse(bodies[1] ?? "{}").image).toBe(HETZNER_STOCK_IMAGE);
  });

  it("never retries an ambiguous failure, which could duplicate a server", async () => {
    const { bodies, fetcher } = recordingFetcher(() =>
      Response.json({ error: { code: "rate_limit_exceeded", message: "slow down" } }, { status: 429 }));
    const provider = new HetznerProvider("t", { fetcher, serverImages: "*=163000001" });
    await expect(provider.createVm(CREATE)).rejects.toThrow("slow down");
    expect(bodies).toHaveLength(1);
  });
});

describe("volume retention sweep", () => {
  const NOW = 10 * VOLUME_RETENTION_MS;

  beforeEach(async () => {
    await resetDatabase();
    // volume_ownership has foreign keys onto orgs and memberships.
    await operatorSession();
  });

  async function seed(volumeId: string, autoCreated: number, detachedAt: number): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO volume_ownership
       (volume_id, org_id, created_by_membership_id, created_at,
        compute_credential_source, auto_created, detached_at)
       VALUES (?1, 'personal', 'personal', 0, 'deployment', ?2, ?3)`,
    ).bind(volumeId, autoCreated, detachedAt).run();
  }

  function sweepRuntime(deleteVolume: (id: string) => Promise<void>) {
    const runtime = testRuntime(new FakeProviders());
    runtime.providers.volume = {
      forOrg: async () => ({
        // SAFETY: the sweep calls deleteVolume and nothing else.
        provider: { deleteVolume } as unknown as VolumeProvider,
        credentialSource: "deployment",
      }),
    };
    return runtime;
  }

  it("reclaims an expired volume and spares one still inside its window", async () => {
    // Reclaiming early destroys the only copy of /workspace, so the window is
    // the guard that makes a destroy reversible.
    await seed("20001", 1, NOW - VOLUME_RETENTION_MS - 1);
    await seed("20002", 1, NOW - 1_000);
    const deleteVolume = vi.fn(async () => {});

    expect(await runVolumeRetentionSweep(sweepRuntime(deleteVolume), NOW)).toBe(1);
    expect(deleteVolume.mock.calls).toEqual([["20001"]]);
    expect(
      await env.DB.prepare("SELECT volume_id FROM volume_ownership WHERE volume_id = '20002'").first(),
    ).not.toBeNull();
  });

  it("never reclaims a volume the operator made by hand", async () => {
    await seed("20003", 0, NOW - VOLUME_RETENTION_MS - 1);
    const deleteVolume = vi.fn(async () => {});

    expect(await runVolumeRetentionSweep(sweepRuntime(deleteVolume), NOW)).toBe(0);
    expect(deleteVolume).not.toHaveBeenCalled();
  });
});
