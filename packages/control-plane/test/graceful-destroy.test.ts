import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HetznerProvider } from "../core/providers/hetzner.js";
import {
  appRequest,
  appWithProviders,
  FakeProviders,
  operatorSession,
  resetDatabase,
} from "./helpers.js";

const SERVER_ID = "42";

interface TestClock {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

class RecordingVolumes extends FakeProviders {
  constructor(
    private readonly events: string[],
  ) {
    super();
  }

  override async detachVolume(volumeId: string, vmId: string): Promise<void> {
    this.events.push(`detach:${volumeId}:${vmId}`);
    await super.detachVolume(volumeId, vmId);
  }
}

function serverResponse(status: string): Response {
  return Response.json({
    server: {
      id: Number(SERVER_ID),
      public_net: { ipv4: { ip: "203.0.113.42" } },
      status,
    },
  });
}

function providerWithClock(clock: TestClock): HetznerProvider {
  return new HetznerProvider("test-token", clock);
}

async function seedWorkspace(volumeId: string | null): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO workspaces
       (id, owner_id, org_id, owner_membership_id, phase, revision, vm_id,
        volume_id, created_at, updated_at)
       VALUES ('workspace-id', 'operator', 'personal', 'personal', 'ready', 1, ?1, ?2, 1, 1)`,
    )
    .bind(SERVER_ID, volumeId)
    .run();
}

describe("graceful workspace destruction", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("gracefully shuts down a VM with an attached volume before detach and delete", async () => {
    const events: string[] = [];
    const statuses = ["stopping", "off"];
    let now = 0;
    const clock: TestClock = {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        const url = String(input);
        if (url.endsWith(`/servers/${SERVER_ID}/actions/shutdown`)) {
          events.push("shutdown");
          expect(init?.method).toBe("POST");
          return Response.json({ action: { status: "running" } });
        }
        if (url.endsWith(`/servers/${SERVER_ID}`) && init?.method === undefined) {
          const status = statuses.shift() ?? "off";
          events.push(`status:${status}`);
          return serverResponse(status);
        }
        if (url.endsWith(`/servers/${SERVER_ID}`) && init?.method === "DELETE") {
          events.push("delete");
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected Hetzner request: ${init?.method ?? "GET"} ${url}`);
      },
    );
    const volumes = new RecordingVolumes(events);
    const app = appWithProviders(providerWithClock(clock), volumes);
    const cookie = await operatorSession(app);
    await seedWorkspace("volume-1");

    const response = await appRequest(app, "/workspaces/workspace-id", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(events).toEqual([
      "shutdown",
      "status:stopping",
      "status:off",
      `detach:volume-1:${SERVER_ID}`,
      "delete",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("deletes a VM without a volume directly without shutdown or polling", async () => {
    const events: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        const url = String(input);
        if (url.endsWith(`/servers/${SERVER_ID}`) && init?.method === "DELETE") {
          events.push("delete");
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected Hetzner request: ${init?.method ?? "GET"} ${url}`);
      },
    );
    const app = appWithProviders(
      new HetznerProvider("test-token"),
      new RecordingVolumes(events),
    );
    const cookie = await operatorSession(app);
    await seedWorkspace(null);

    const response = await appRequest(app, "/workspaces/workspace-id", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(events).toEqual(["delete"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("deletes after graceful shutdown polling reaches the 45-second cap", async () => {
    const events: string[] = [];
    let now = 0;
    const clock: TestClock = {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        const url = String(input);
        if (url.endsWith(`/servers/${SERVER_ID}/actions/shutdown`)) {
          events.push("shutdown");
          return Response.json({ action: { status: "running" } });
        }
        if (url.endsWith(`/servers/${SERVER_ID}`) && init?.method === undefined) {
          events.push("status:running");
          return serverResponse("running");
        }
        if (url.endsWith(`/servers/${SERVER_ID}`) && init?.method === "DELETE") {
          events.push("delete");
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected Hetzner request: ${init?.method ?? "GET"} ${url}`);
      },
    );
    const volumes = new RecordingVolumes(events);
    const app = appWithProviders(providerWithClock(clock), volumes);
    const cookie = await operatorSession(app);
    await seedWorkspace("volume-1");

    const response = await appRequest(app, "/workspaces/workspace-id", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(now).toBe(45_000);
    expect(events[0]).toBe("shutdown");
    expect(events.filter((event) => event === "status:running")).toHaveLength(45);
    expect(events.slice(-2)).toEqual([`detach:volume-1:${SERVER_ID}`, "delete"]);
    expect(fetchMock).toHaveBeenCalledTimes(47);
  });

  it("aborts a hung shutdown status request at the 45-second total deadline before detach and delete", async () => {
    const events: string[] = [];
    let statusSignal: AbortSignal | null | undefined;
    let resolveShutdownStarted!: () => void;
    let resolveStatusStarted!: () => void;
    const shutdownStarted = new Promise<void>((resolve) => {
      resolveShutdownStarted = resolve;
    });
    const statusStarted = new Promise<void>((resolve) => {
      resolveStatusStarted = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        const url = String(input);
        if (url.endsWith(`/servers/${SERVER_ID}/actions/shutdown`)) {
          events.push("shutdown");
          resolveShutdownStarted();
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(Response.json({ action: { status: "running" } }));
            }, 5_000);
          });
        }
        if (url.endsWith(`/servers/${SERVER_ID}`) && init?.method === undefined) {
          events.push("status:started");
          statusSignal = init?.signal;
          resolveStatusStarted();
          return new Promise<Response>((_resolve, reject) => {
            statusSignal?.addEventListener(
              "abort",
              () => {
                events.push("status:aborted");
                reject(statusSignal?.reason);
              },
              { once: true },
            );
          });
        }
        if (url.endsWith(`/servers/${SERVER_ID}`) && init?.method === "DELETE") {
          events.push("delete");
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected Hetzner request: ${init?.method ?? "GET"} ${url}`);
      },
    );
    const volumes = new RecordingVolumes(events);
    const app = appWithProviders(new HetznerProvider("test-token"), volumes);
    const cookie = await operatorSession(app);
    await seedWorkspace("volume-1");
    vi.useFakeTimers();
    const startedAt = Date.now();

    const responsePromise = appRequest(app, "/workspaces/workspace-id", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    await shutdownStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    await statusStarted;
    await vi.advanceTimersByTimeAsync(39_999);

    expect(statusSignal).toBeInstanceOf(AbortSignal);
    expect(statusSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const response = await responsePromise;

    expect(Date.now() - startedAt).toBe(45_000);
    expect(statusSignal?.aborted).toBe(true);
    expect(response.status).toBe(200);
    expect(events).toEqual([
      "shutdown",
      "status:started",
      "status:aborted",
      `detach:volume-1:${SERVER_ID}`,
      "delete",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
