import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { appRequest, harness } from "./helpers.js";

describe("versioned box-payload routes", () => {
  it("publicly serves only the three payload artifact names", async () => {
    const { app } = harness();
    const version = "a1b2c3d4";
    await env.BOX_IMAGES.put(
      `box-payload/${version}/manifest.json`,
      '{"version":"a1b2c3d4"}',
      { httpMetadata: { contentType: "application/json" } },
    );
    await env.BOX_IMAGES.put(`box-payload/${version}/payload.tar.gz`, "payload");
    await env.BOX_IMAGES.put(`box-payload/${version}/daemon.tar.gz`, "daemon");

    for (const [name, expected] of [
      ["manifest.json", '{"version":"a1b2c3d4"}'],
      ["payload.tar.gz", "payload"],
      ["daemon.tar.gz", "daemon"],
    ]) {
      const response = await appRequest(app, `/box-payload/${version}/${name}`);
      expect(response.status, name).toBe(200);
      expect(await response.text(), name).toBe(expected);
    }
  });

  it("hides invalid versions and every other key in the bucket", async () => {
    const { app } = harness();
    await env.BOX_IMAGES.put("box-payload/release/private", "hidden");
    for (const requestPath of [
      "/box-payload/-release/manifest.json",
      `/box-payload/${"a".repeat(65)}/manifest.json`,
      "/box-payload/release/private",
      "/box-payload/release/payload.tar",
      "/box-payload/release/manifest.json.extra",
    ]) {
      const response = await appRequest(app, requestPath);
      expect(response.status, requestPath).toBe(404);
      expect(await response.json(), requestPath).toEqual({
        error: "not found",
        retryAction: null,
      });
    }
  });
});
