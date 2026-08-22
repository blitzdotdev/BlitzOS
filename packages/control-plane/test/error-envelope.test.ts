import { env } from "cloudflare:test";
import { HTTPException } from "hono/http-exception";
import { $Database, ProcessError, teenyHono } from "teenybase/worker";
import type { $Env } from "teenybase/worker";
import { describe, expect, it, vi } from "vitest";
import {
  credentialMasterKeyFor,
  installControlPlaneRoutes,
  type CoreRouter,
  type CoreRuntime,
} from "../core/index.js";
import { HttpError, type JsonObject } from "../core/http.js";
import { managedApiRequest } from "../scripts/lib/managed-api.mjs";
import config from "../teenybase.js";
import { CRED_MASTER_KEY } from "./helpers.js";

// Run-4 report, B2. installControlPlaneRoutes registers the app's only error
// handler: teenyHono installs teenybase's first, and Hono keeps exactly one.
// Every framework throw therefore lands here, and flattening it to 500 hid a
// 404, a NOT NULL violation, an "Invalid file name" and a failed upload behind
// one identical envelope — on self-host too, which shares this file.

const credentialMasterKey = await credentialMasterKeyFor(CRED_MASTER_KEY);
const ROUTE = "https://control-plane.test/throwing-route";

type ErrorEnv = $Env<Env> & {
  Variables: $Env<Env>["Variables"] & { $credentialMasterKey: CryptoKey };
};

/** The route shape both targets deploy — teenyHono underneath, control-plane
 * routes on top — plus one route that throws what the framework throws. */
function appThatThrows(thrown: Error) {
  const app = teenyHono<ErrorEnv>(
    async (context) => {
      context.set("$credentialMasterKey", credentialMasterKey);
      return new $Database(context, config, context.env.DB, context.env.BOX_IMAGES);
    },
    undefined,
    { cors: false, logger: false },
  );
  app.get("/throwing-route", () => {
    throw thrown;
  });
  const runtimeFor = (): CoreRuntime => {
    throw new Error("the throwing route never reaches the runtime");
  };
  // SAFETY: The Hono app and CoreRouter expose the same route-registration methods consumed by installControlPlaneRoutes.
  installControlPlaneRoutes(app as unknown as CoreRouter, runtimeFor);
  return app;
}

async function throwing(thrown: Error): Promise<Response> {
  return appThatThrows(thrown).request(ROUTE, undefined, env);
}

async function expectEnvelope(thrown: Error, status: number, body: JsonObject): Promise<void> {
  const response = await throwing(thrown);
  expect(response.status, thrown.message).toBe(status);
  expect(await response.json(), thrown.message).toEqual(body);
}

const access = {
  base: "https://blitz.dev/api/v1/projects/example",
  appUrl: "https://example.app.blitz.dev",
  token: "private-agent-token",
};

/** The uploader's read of a not-yet-uploaded asset row, driven by a real
 * response from the real handler instead of a hand-written status. */
async function readAsUploader(response: Response) {
  const read = await managedApiRequest(
    access,
    "/exec/blitz_files/view/webapp-index-html",
    {},
    async () => response,
    { allowMissing: true },
  );
  return read.body;
}

describe("control-plane error envelope", () => {
  it("surfaces the status and message a framework error already chose", async () => {
    // Exactly what teenybase throws for a missing row ($Database: 'Not found', 404).
    await expectEnvelope(new ProcessError("Not found", 404), 404, {
      error: "Not found",
      retryAction: null,
    });
    // The malformed-probe faults run 4 could not tell apart from the real one.
    await expectEnvelope(new ProcessError("Invalid file name someKey"), 400, {
      error: "Invalid file name someKey",
      retryAction: null,
    });
    await expectEnvelope(new HTTPException(409, { message: "row already exists" }), 409, {
      error: "row already exists",
      retryAction: null,
    });
    // A framework error may carry no message at all; an empty `error` field
    // reads as a broken response rather than as the status it is.
    await expectEnvelope(new HTTPException(404), 404, { error: "request failed", retryAction: null });
  });

  it("keeps the control-plane's own HttpError envelope unchanged", async () => {
    await expectEnvelope(new HttpError(403, "active membership required"), 403, {
      error: "active membership required",
      retryAction: null,
    });
    await expectEnvelope(new HttpError(502, "provider rejected", "req-42"), 502, {
      error: "provider rejected",
      request_id: "req-42",
    });
  });

  it("still answers a controlled 500 for an unknown exception", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await throwing(new TypeError("connect ECONNREFUSED 10.0.0.1:5432"));
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ error: "internal server error", retryAction: null });
      expect(body).not.toContain("10.0.0.1");
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  it("logs a framework 5xx and stays quiet for a framework 4xx", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expectEnvelope(new ProcessError("upstream unavailable", 503), 503, {
        error: "upstream unavailable",
        retryAction: null,
      });
      expect(logged).toHaveBeenCalledTimes(1);
      logged.mockClear();
      await throwing(new ProcessError("Not found", 404));
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("leaves an error carrying a status but no framework contract as a 500", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // A D1 failure has a code-shaped field and no HTTP meaning. Echoing its
      // status or its message would publish schema detail nobody chose to.
      const d1 = Object.assign(new Error("D1_ERROR: no such column: secret_hash"), { status: 400 });
      await expectEnvelope(d1, 500, { error: "internal server error", retryAction: null });
    } finally {
      logged.mockRestore();
    }
  });

  // The run-4 uploader break, end to end. readManagedFileRow reads a
  // not-yet-uploaded row with allowMissing, and managed-api.mjs treats 404 —
  // and only 404 — as absent. Under the old handler every upload's first
  // asset 500'd here, so the webapp upload could not have survived its first
  // file even with the platform's own R2 defect fixed.
  it("returns a 404 the managed uploader reads as an absent row", async () => {
    const missing = await throwing(new ProcessError("Not found", 404));
    expect(missing.status).toBe(404);
    expect(await readAsUploader(missing)).toBeNull();
  });

  it("keeps the uploader failing loudly when the throw really is unknown", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const flattened = await throwing(new Error("swallowed"));
      expect(flattened.status).toBe(500);
      await expect(readAsUploader(flattened)).rejects.toThrow(/API 500/u);
    } finally {
      logged.mockRestore();
    }
  });
});
