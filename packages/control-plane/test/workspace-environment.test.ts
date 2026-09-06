import { beforeEach, describe, expect, it } from "vitest";
import {
  appRequest,
  harness,
  operatorSession,
  resetDatabase,
} from "./helpers.js";

describe("retired workspace create fields", () => {
  beforeEach(resetDatabase);

  it("rejects a legacy environment field on a create", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultMachineTypeId: "small",
        environment: { env: { API_ORIGIN: "https://api.example" }, startupScript: null },
      }),
    });
    expect(created.status).toBe(400);
    await expect(created.json()).resolves.toEqual({
      error: "request body has unexpected field environment",
      retryAction: null,
    });
  });

  it("rejects a create body larger than the request ceiling", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const response = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultMachineTypeId: "small",
        userData: "#cloud-config\n".padEnd(200 * 1024, "x"),
      }),
    });
    expect(response.status).toBe(413);
  });
});
