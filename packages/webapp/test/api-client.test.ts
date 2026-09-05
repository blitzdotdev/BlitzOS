import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlaneClient } from "../src/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("wire API client", () => {
  it("sends compute credentials to the org provider route and returns metadata only", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({
            provider: "hetzner",
            validated_at: 123,
            created_by: "membership-one",
          })
    ));
    vi.stubGlobal("fetch", fetcher);
    const client = createControlPlaneClient("https://control.example");

    const metadata = await client.putComputeCredential(
      "org/one",
      "hetzner",
      { token: "paste-once" },
    );
    await client.deleteComputeCredential("org/one", "hetzner");

    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://control.example/orgs/org%2Fone/compute-credentials/hetzner",
    );
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ token: "paste-once" }));
    expect(metadata).toEqual({
      provider: "hetzner",
      validated_at: 123,
      created_by: "membership-one",
    });
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("drives the org credential plane on the session's own organization", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ ok: true })
    ));
    vi.stubGlobal("fetch", fetcher);
    const client = createControlPlaneClient("https://control.example");

    await client.listOrgCredentials();
    await client.listOrgCredentials(undefined, "workspace/one");
    await client.putOrgCredential({ name: "STRIPE_API_KEY", value: "sk", grants: [] });
    await client.replaceOrgCredentialGrants("STRIPE_API_KEY", {
      grants: [{ subjectKind: "org", subjectId: null, access: "read" }],
    });
    await client.importOrgCredentials({ text: "A=1\n", dryRun: true });
    await client.revokeOrgCredential("STRIPE_API_KEY");
    await client.listGrantProposals();
    await client.resolveGrantProposal("p/1", { approve: false, changes: [] });

    const calls = fetcher.mock.calls.map(([url, init]) => [String(url), init?.method ?? "GET"]);
    expect(calls).toEqual([
      ["https://control.example/orgs/self/credentials", "GET"],
      ["https://control.example/orgs/self/credentials?workspaceId=workspace%2Fone", "GET"],
      ["https://control.example/orgs/self/credentials", "PUT"],
      ["https://control.example/orgs/self/credentials/STRIPE_API_KEY/grants", "PUT"],
      ["https://control.example/orgs/self/credentials/dotenv", "POST"],
      ["https://control.example/orgs/self/credentials/STRIPE_API_KEY", "DELETE"],
      ["https://control.example/orgs/self/grant-proposals", "GET"],
      ["https://control.example/orgs/self/grant-proposals/p%2F1/resolve", "POST"],
    ]);
    expect(fetcher.mock.calls[7]?.[1]?.body).toBe(JSON.stringify({ approve: false, changes: [] }));
  });

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
    await client.create({ defaultMachineTypeId: "cx23@fsn1" });

    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-operator-key")).toBeNull();
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ defaultMachineTypeId: "cx23@fsn1" }));
  });

  it("disconnects one workspace connection by name and never touches the lease", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 204 })
    ));
    vi.stubGlobal("fetch", fetcher);
    const client = createControlPlaneClient("https://control.example");

    await client.disconnectWorkspaceConnection("work space/one", "google-workspace");

    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://control.example/workspaces/work%20space%2Fone/connections/google-workspace",
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("reads GitHub installations and repositories from their settled routes", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith('/installations')
        ? Response.json({ installations: [] })
        : Response.json({ source: 'installations', repositories: [], truncated: false })
    ));
    vi.stubGlobal("fetch", fetcher);
    const client = createControlPlaneClient("https://control.example");

    await client.listGithubInstallations();
    await client.listGithubRepositories();

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      'https://control.example/connections/github/installations',
      'https://control.example/connections/github/repositories',
    ]);
  });

  it("builds base-aware connect URLs for workspaces", () => {
    const client = createControlPlaneClient("https://control.example");

    expect(client.connectStartUrl("github", undefined, "workspace-new"))
      .toBe(
        "https://control.example/connect/github/start?returnTo=workspace-new",
      );
    expect(client.connectStartUrl("github", "workspace/one"))
      .toBe(
        "https://control.example/connect/github/start?workspaceId=workspace%2Fone",
      );
  });

});
