import { beforeEach, describe, expect, it } from "vitest";
import type { CreateVmInput, WebAppPort } from "../core/compute/types.js";
import { BOX_IMAGE_TICKETS_SINCE_MS, BOX_IMAGE_VIEWER_GUARDS_SINCE_MS } from "../core/webapp-tickets.js";
import {
  FakeProviders,
  appRequest,
  appWithProviders,
  createWorkspace,
  operatorSession,
  resetDatabase,
} from "./helpers.js";

/** appRequest addresses the app at this origin, so it is what a browser on
 * this deployment would send. */
const APP_ORIGIN = "https://cp.example";

/** What the box gateway accepts on any image, and what the proxy must forward
 * in place of the browser's origin. */
const BOX_ACCEPTED_ORIGIN = "http://localhost";

const UPGRADE_HEADERS = {
  Connection: "Upgrade",
  Upgrade: "websocket",
  "Sec-WebSocket-Version": "13",
};

class OriginRecordingProviders extends FakeProviders {
  readonly forwardedOrigins: Array<string | null> = [];

  override capabilities() {
    return {
      ...super.capabilities(),
      webAppTicketsSinceMs: BOX_IMAGE_TICKETS_SINCE_MS,
      webAppViewerGuardsSinceMs: BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
    };
  }

  override async createVm(input: CreateVmInput) {
    return super.createVm(input);
  }

  async proxyWebApp(
    _id: string,
    _port: WebAppPort,
    _pathAndQuery: string,
    request: Request,
  ): Promise<Response> {
    this.forwardedOrigins.push(request.headers.get("origin"));
    return new Response(null, { status: 200 });
  }
}

// A box writes the control-plane origin into /var/lib/blitz/origin once, at
// creation, and its gateway then refuses any websocket whose Origin does not
// equal that string. Moving the app to a new domain broke every workspace made
// before the move: plain requests kept working, every websocket answered 403,
// and the box had no error to show because it was behaving correctly.
describe("webApp websocket origin", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("forwards the origin every box accepts, so a pre-cutover box still upgrades", async () => {
    const providers = new OriginRecordingProviders();
    const app = appWithProviders(providers, providers);
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);

    const response = await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/terminal/ws`, {
      headers: { Cookie: cookie, Origin: APP_ORIGIN, ...UPGRADE_HEADERS },
    });

    expect(response.status).toBe(200);
    expect(providers.forwardedOrigins).toEqual([BOX_ACCEPTED_ORIGIN]);
  });

  it("rejects an upgrade from another site before minting a credential", async () => {
    const providers = new OriginRecordingProviders();
    const app = appWithProviders(providers, providers);
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);

    const response = await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/terminal/ws`, {
      headers: { Cookie: cookie, Origin: "https://evil.example", ...UPGRADE_HEADERS },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "websocket origin forbidden", retryAction: null });
    // The CSRF gate moved here from the box, so nothing may reach the box.
    expect(providers.forwardedOrigins).toEqual([]);
  });

  it("rejects an upgrade that sends no origin at all", async () => {
    const providers = new OriginRecordingProviders();
    const app = appWithProviders(providers, providers);
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);

    const response = await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/terminal/ws`, {
      headers: { Cookie: cookie, ...UPGRADE_HEADERS },
    });

    expect(response.status).toBe(403);
    expect(providers.forwardedOrigins).toEqual([]);
  });

  it("leaves a plain request's origin alone, so the box's CORS answer stays truthful", async () => {
    const providers = new OriginRecordingProviders();
    const app = appWithProviders(providers, providers);
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);

    const response = await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/ports`, {
      headers: { Cookie: cookie, Origin: APP_ORIGIN },
    });

    expect(response.status).toBe(200);
    expect(providers.forwardedOrigins).toEqual([APP_ORIGIN]);
  });
});
