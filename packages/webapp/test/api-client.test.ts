import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlaneClient } from "../src/api.js";
import { FILES_MULTIPART_CHUNK_BYTES } from "@blitzos/schema";

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

  it("builds base-aware connect URLs for closed return surfaces", () => {
    const client = createControlPlaneClient("https://control.example");

    expect(client.connectStartUrl("github", undefined, "template-edit:template/one"))
      .toBe(
        "https://control.example/connect/github/start?returnTo=template-edit%3Atemplate%2Fone",
      );
    expect(client.connectStartUrl("github", "workspace/one"))
      .toBe(
        "https://control.example/connect/github/start?workspaceId=workspace%2Fone",
      );
  });

  it("chunks large folder uploads with the shared cutoff and completes ordered parts", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/multipart") && init?.method === "POST") {
        return Response.json({ uploadId: "upload-one" }, { status: 201 });
      }
      if (url.includes("/multipart/upload-one/") && init?.method === "PUT") {
        const partNumber = Number(url.split("/").at(-1));
        return Response.json({ partNumber, etag: `etag-${partNumber}` });
      }
      if (url.endsWith("/multipart/upload-one/complete")) {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    const client = createControlPlaneClient("https://control.example");
    const file = new File(
      [new Uint8Array(FILES_MULTIPART_CHUNK_BYTES), new Uint8Array([7])],
      "large.bin",
      { lastModified: 1234 },
    );

    await client.uploadFolderObject("folder", "nested/large.bin", file);

    const partCalls = fetcher.mock.calls.filter(([input, init]) => (
      String(input).includes("/multipart/upload-one/") && init?.method === "PUT"
    ));
    expect(partCalls).toHaveLength(2);
    expect((partCalls[0]?.[1]?.body as Blob).size).toBe(FILES_MULTIPART_CHUNK_BYTES);
    expect((partCalls[1]?.[1]?.body as Blob).size).toBe(1);
    const complete = fetcher.mock.calls.find(([input]) => String(input).endsWith("/complete"));
    expect(complete?.[1]?.body).toBe(JSON.stringify({
      parts: [
        { partNumber: 1, etag: "etag-1" },
        { partNumber: 2, etag: "etag-2" },
      ],
    }));
  });
});
