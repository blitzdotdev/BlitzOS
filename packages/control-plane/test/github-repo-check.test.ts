import type { CheckGithubRepositoriesResponse, JsonValue } from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRequest, harness, operatorSession, resetDatabase } from "./helpers.js";

const ROUTE = "/connections/github/repositories/check";

type Harness = ReturnType<typeof harness>;

interface ErrorResponse {
  error: string;
  retryAction: null;
}

interface RejectedBody {
  label: string;
  body: JsonValue;
  message: string;
}

const rejectedBodies: RejectedBody[] = [
  {
    label: "a non-object body",
    body: [],
    message: "request body must be an object",
  },
  {
    label: "a non-array repos field",
    body: { repos: "owner/name" },
    message: "repos must be an array",
  },
  {
    label: "a non-string entry",
    body: { repos: [1] },
    message: "repos[0] must be a non-empty string",
  },
  {
    label: "an entry over 256 characters",
    body: { repos: [`owner/${"a".repeat(251)}`] },
    message: "repos[0] must be a non-empty string",
  },
  {
    label: "more than sixteen entries",
    body: { repos: Array.from({ length: 17 }, (_, index) => `owner/repo-${String(index)}`) },
    message: "repos must have at most 16 entries",
  },
  {
    label: "an entry outside owner/name syntax",
    body: { repos: ["owner"] },
    message: "repos entries must be \"owner/name\": owner",
  },
  {
    label: "an empty repo list",
    body: { repos: [] },
    message: "repos must not be empty",
  },
];

async function check(
  app: Harness["app"],
  cookie: string,
  body: JsonValue,
): Promise<Response> {
  return appRequest(app, ROUTE, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GitHub public repository checks", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires an active organization membership", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    await env.DB.prepare("UPDATE sessions SET membership_id = NULL").run();
    const fetch = vi.spyOn(globalThis, "fetch");

    const response = await check(app, cookie, { repos: ["owner/name"] });

    expect(response.status).toBe(403);
    await expect(response.json<ErrorResponse>()).resolves.toEqual({
      error: "active membership required",
      retryAction: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(rejectedBodies)("rejects $label", async ({ body, message }) => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const fetch = vi.spyOn(globalThis, "fetch");

    const response = await check(app, cookie, body);

    expect(response.status).toBe(400);
    await expect(response.json<ErrorResponse>()).resolves.toEqual({
      error: message,
      retryAction: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps mixed probe verdicts in request order", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("owner/public.git")) return new Response(null, { status: 200 });
      if (url.includes("owner/private.git")) return new Response(null, { status: 404 });
      return new Response(null, { status: 500 });
    });

    const response = await check(app, cookie, {
      repos: ["owner/public", "owner/private", "owner/broken"],
    });

    expect(response.status).toBe(200);
    await expect(response.json<CheckGithubRepositoriesResponse>()).resolves.toEqual({
      results: [
        { repo: "owner/public", reachable: true },
        { repo: "owner/private", reachable: false, failure: "not-public" },
        { repo: "owner/broken", reachable: false, failure: "unreachable" },
      ],
    });
  });

  it("uses the exact anonymous Git transport request", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const requests: Array<{
      url: string;
      authorization: string | null;
      userAgent: string | null;
      method: string | undefined;
    }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("Authorization"),
        userAgent: headers.get("User-Agent"),
        method: init?.method,
      });
      return new Response("body must not be read", { status: 200 });
    });

    const response = await check(app, cookie, { repos: ["owner/name"] });

    expect(response.status).toBe(200);
    expect(requests).toEqual([{
      url: "https://github.com/owner/name.git/info/refs?service=git-upload-pack",
      authorization: null,
      userAgent: "blitz-control-plane",
      method: "GET",
    }]);
  });

  it("turns a thrown probe into an unreachable verdict", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failed"));

    const response = await check(app, cookie, { repos: ["owner/name"] });

    expect(response.status).toBe(200);
    await expect(response.json<CheckGithubRepositoriesResponse>()).resolves.toEqual({
      results: [{ repo: "owner/name", reachable: false, failure: "unreachable" }],
    });
  });

  it("collapses duplicate entries before probing", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const response = await check(app, cookie, {
      repos: ["owner/name", "owner/name", "owner/name"],
    });

    expect(response.status).toBe(200);
    await expect(response.json<CheckGithubRepositoriesResponse>()).resolves.toEqual({
      results: [{ repo: "owner/name", reachable: true }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
