import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  managedApiRequest,
  migrationText,
  saveVersion,
} from "../scripts/lib/managed-api.mjs";

// Vendor-only: this suite exercises the blitz.dev managed platform client,
// which forks do not deploy through. Skipped unless BLITZDEV_MANAGED=1.
const managedToolchainEnabled = env.BLITZDEV_MANAGED === "1";

const access = {
  base: "https://blitz.dev/api/v1/projects/example",
  appUrl: "https://example.app.blitz.dev",
  token: "private-agent-token",
};

describe.skipIf(!managedToolchainEnabled)("blitz.dev managed API response contract [vendor-only: set BLITZDEV_MANAGED=1 to run]", () => {
  it("constructs authenticated requests and preserves JSON and text bodies", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{"success":true}', {
        headers: { "x-save-version": "7" },
      }));

    const result = await managedApiRequest(
      access,
      "/files?path=core%2Findex.ts",
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain; charset=utf-8", "If-Match": "6" },
        body: "source",
      },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "https://blitz.dev/api/v1/projects/example/files?path=core%2Findex.ts",
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer private-agent-token",
          "Content-Type": "text/plain; charset=utf-8",
          "If-Match": "6",
        },
        body: "source",
      },
    );
    expect(result.body).toEqual({ success: true });
    expect(saveVersion(result.response, result.body)).toBe("7");

    const textFetcher = vi.fn(async () => new Response("SELECT 1;"));
    await expect(managedApiRequest(access, "/files?path=%40migration.sql", {}, textFetcher))
      .resolves.toMatchObject({ body: "SELECT 1;" });
  });

  it("keeps response-version precedence and migration payload candidate order", () => {
    const response = new Response("", {
      headers: { "x-save-version": "header", etag: 'W/"etag"' },
    });
    expect(saveVersion(response, { result: { version: 42 } })).toBe("42");
    expect(saveVersion(response, {})).toBe("header");
    expect(saveVersion(new Response("", { headers: { etag: 'W/"etag"' } }), {})).toBe("etag");
    expect(migrationText("SELECT direct;")).toBe("SELECT direct;");
    expect(migrationText({
      result: { content: "SELECT content;", text: "SELECT text;", sql: "SELECT sql;" },
      content: "SELECT outer;",
    })).toBe("SELECT content;");
    expect(() => migrationText({ result: {} })).toThrow(
      "migration response did not contain SQL text",
    );
  });

  it("rejects non-success responses with redacted credentials", async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ token: "tp__secret-value", password: "project-secret" }),
      { status: 409 },
    ));

    await expect(managedApiRequest(access, "/files", {}, fetcher)).rejects.toThrow(
      'API 409: {"token":"[REDACTED]","password":"[REDACTED]"}',
    );
  });
});
