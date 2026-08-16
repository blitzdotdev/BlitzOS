import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlaneClient } from "../src/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("wire API client", () => {
  it("uses Google login and omits an absent SSH key from create", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      return new Response(JSON.stringify({
        workspace: {
          id: "one",
          phase: "creating",
          retryAction: "poll",
          canObserve: false,
          launchable: false,
          revision: 1,
          ssh: null,
          volumeId: null,
          error: null,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const client = createControlPlaneClient("https://control.example");

    expect(client.googleLoginUrl()).toBe("https://control.example/auth/google/start");
    await client.create({ machineTypeId: "cx23@fsn1" });

    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-operator-key")).toBeNull();
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ machineTypeId: "cx23@fsn1" }));
  });
});
