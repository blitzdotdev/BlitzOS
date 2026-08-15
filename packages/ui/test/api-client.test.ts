import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlaneClient } from "../src/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("wire API client", () => {
  it("logs in with x-operator-key and omits an absent SSH key from create", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/sessions") return new Response(null, { status: 204 });
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

    await client.login("operator-secret");
    await client.create({ machineTypeId: "cx23@fsn1" });

    const loginInit = fetcher.mock.calls[0]?.[1];
    expect(new Headers(loginInit?.headers).get("x-operator-key")).toBe("operator-secret");
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ machineTypeId: "cx23@fsn1" }));
  });
});
