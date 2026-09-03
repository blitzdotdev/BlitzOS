import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { appRequest, harness } from "./helpers.js";

describe("versioned box-image routes", () => {
  it("serves a release manifest and its numbered parts from their logical keys", async () => {
    const { app } = harness();
    await env.BOX_IMAGES.put(
      "box-image/1a2b3c4d5e6f/manifest.json",
      '{"imageTag":"blitz-box:1a2b3c4d5e6f"}',
      { httpMetadata: { contentType: "application/json" } },
    );
    await env.BOX_IMAGES.put("box-image/1a2b3c4d5e6f/part-000", "first part", {
      httpMetadata: { contentType: "application/octet-stream" },
    });

    const manifest = await appRequest(app, "/box-image/1a2b3c4d5e6f/manifest.json");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe("application/json");
    expect(await manifest.text()).toBe('{"imageTag":"blitz-box:1a2b3c4d5e6f"}');

    const part = await appRequest(app, "/box-image/1a2b3c4d5e6f/part-000");
    expect(part.status).toBe(200);
    expect(new TextDecoder().decode(await part.arrayBuffer())).toBe("first part");
  });

  it("accepts the full release alphabet and part numbers wider than three digits", async () => {
    const { app } = harness();
    const release = `a${"B._-9".repeat(12)}xyz`;
    expect(release).toHaveLength(64);
    await env.BOX_IMAGES.put(`box-image/${release}/part-1234`, "wide part");

    const response = await appRequest(app, `/box-image/${release}/part-1234`);
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("wide part");
  });

  it("returns the existing not-found envelope for invalid releases and part names", async () => {
    const { app } = harness();
    const invalidPaths = [
      "/box-image/-release/manifest.json",
      `/box-image/${"a".repeat(65)}/manifest.json`,
      "/box-image/release%20name/manifest.json",
      "/box-image/release/part-00",
      "/box-image/release/part-abc",
      "/box-image/release/manifest.json.extra",
    ];
    // Even an existing object behind an invalid logical name must not bypass
    // the public route's bounded release and part grammar.
    await env.BOX_IMAGES.put("box-image/release/part-00", "must stay hidden");

    for (const requestPath of invalidPaths) {
      const response = await appRequest(app, requestPath);
      expect(response.status, requestPath).toBe(404);
      expect(await response.json(), requestPath).toEqual({
        error: "not found",
        retryAction: null,
      });
    }
  });

  it("keeps the unversioned manifest and arbitrary legacy part route serving", async () => {
    const { app } = harness();
    await env.BOX_IMAGES.put("box-image/manifest.json", "legacy manifest");
    await env.BOX_IMAGES.put("box-image/archive.part1", "legacy part");

    const manifest = await appRequest(app, "/box-image/manifest.json");
    const part = await appRequest(app, "/box-image/archive.part1");
    expect(new TextDecoder().decode(await manifest.arrayBuffer())).toBe("legacy manifest");
    expect(new TextDecoder().decode(await part.arrayBuffer())).toBe("legacy part");
  });
});
